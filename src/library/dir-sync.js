// @ts-check
import { join } from 'node:path';
import { listDirectory } from './walk.js';
import { buildItem } from './item-builder.js';
import { categoryForFolder } from './categories.js';
import { SCAN_VERSION } from './parsers/compat.js';
import { sortKey } from './parsers/text.js';
import { getItemsByDir, upsertItem, upsertSeries, deleteItem } from '../db/library-repo.js';

/**
 * Diffs one directory's current file listing against its indexed rows and
 * applies the result: new/changed files are (re)parsed and upserted,
 * unchanged files are left alone, vanished files are deleted. A file whose
 * `stat` failed with a non-`ENOENT` error keeps its existing row untouched.
 * Writes are applied in transactions of at most 500 rows. Never recurses —
 * the caller (`scanner.js`) drives the depth-first walk using the `dirs`
 * this returns.
 *
 * Spec: docs/specs/spec-library-video.md, "Scanner modules" (`dir-sync.js`).
 */

const MAX_TRANSACTION_ROWS = 500;

/** @typedef {import('./item-builder.js').BuiltItemRow} BuiltItemRow */
/** @typedef {import('../db/library-repo.js').LibraryItemRow} LibraryItemRow */
/**
 * @typedef {object} DirSyncStats
 * @property {number} added
 * @property {number} updated
 * @property {number} removed
 * @property {number} unchanged
 * @property {number} skippedSymlinks
 * @property {number} skippedUndecodable
 */
/**
 * @typedef {object} SyncCtx
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {string} mediaRoot
 * @property {() => number} now
 * @property {import('./walk.js').StatFn} [statFn] test-only override, passed through to `listDirectory`
 */

/**
 * Upserts one built row, resolving `series_id` via `upsertSeries` first when
 * the row carries a `series_key` (category `'series'`). Exported so
 * `reconcile.js`'s single-file path reuses the exact same series hand-off
 * instead of duplicating it (see the spec's Decision log, #32/#33).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {BuiltItemRow} row mutated in place: `series_id` is set when `series_key` is present
 * @param {number} now epoch ms
 * @returns {number} the item's id
 */
export function upsertBuiltRow(db, row, now) {
  if (row.series_key) {
    const title = row.series_title ?? row.series_key;
    row.series_id = upsertSeries(
      db,
      { series_key: row.series_key, title, sort_title: sortKey(title), year: row.series_year ?? null },
      now
    );
  }
  return upsertItem(db, row, now);
}

/**
 * Runs each op in `ops`, committing every `chunkSize` of them in its own
 * transaction so one directory's writes never hold a single huge
 * transaction open.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<() => void>} ops
 * @param {number} [chunkSize]
 * @returns {void}
 */
function runChunked(db, ops, chunkSize = MAX_TRANSACTION_ROWS) {
  for (let i = 0; i < ops.length; i += chunkSize) {
    const chunk = ops.slice(i, i + chunkSize);
    db.exec('BEGIN');
    try {
      for (const op of chunk) op();
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * @param {LibraryItemRow | undefined} existing
 * @param {import('./walk.js').WalkFile} file
 * @returns {boolean}
 */
function isUnchanged(existing, file) {
  if (!existing || !file.stat) return false;
  return (
    existing.size === file.stat.size &&
    existing.mtime_ms === Math.trunc(file.stat.mtimeMs) &&
    existing.scan_version === SCAN_VERSION
  );
}

/**
 * Queues the write op for one candidate file and bumps `stats` accordingly.
 * @param {SyncCtx} ctx
 * @param {string} relPath
 * @param {import('./categories.js').Category} category
 * @param {import('./walk.js').WalkFile} file already-stat'd candidate
 * @param {LibraryItemRow | undefined} existing
 * @param {DirSyncStats} stats mutated in place
 * @param {Array<() => void>} ops mutated in place
 * @returns {Promise<void>}
 */
async function queueFile({ db, mediaRoot, now }, relPath, category, file, existing, stats, ops) {
  if (file.error) {
    return; // keep the existing row (if any) untouched; skip if there was none
  }
  if (existing && isUnchanged(existing, file)) {
    stats.unchanged += 1;
    return;
  }
  const row = await buildItem({
    mediaRoot,
    relPath,
    category,
    stat: /** @type {import('node:fs').Stats} */ (file.stat),
    now,
  });
  if (!row) {
    if (existing) {
      ops.push(() => deleteItem(db, relPath));
      stats.removed += 1;
    }
    return;
  }
  ops.push(() => upsertBuiltRow(db, row, now()));
  stats[existing ? 'updated' : 'added'] += 1;
}

/**
 * @param {SyncCtx} ctx
 * @param {string} relDir '/'-separated, relative to `MEDIA_ROOT` (a category root or below)
 * @returns {Promise<{ stats: DirSyncStats, dirs: string[] }>}
 */
export async function syncDirectory(ctx, relDir) {
  const { db, mediaRoot, statFn } = ctx;
  const absDir = relDir === '' ? mediaRoot : join(mediaRoot, ...relDir.split('/'));
  const category = categoryForFolder(relDir.split('/')[0]);
  if (!category) {
    throw new Error(`syncDirectory: "${relDir}" is not inside a category root`);
  }
  const { files, dirs, skipped } = await listDirectory(absDir, { statFn });
  const existingByPath = new Map(getItemsByDir(db, relDir).map((row) => [row.rel_path, row]));

  /** @type {DirSyncStats} */
  const stats = {
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    skippedSymlinks: skipped.symlinks,
    skippedUndecodable: skipped.undecodable,
  };
  /** @type {Array<() => void>} */
  const ops = [];

  for (const file of files) {
    const relPath = relDir === '' ? file.name : `${relDir}/${file.name}`;
    const existing = existingByPath.get(relPath);
    existingByPath.delete(relPath);
    await queueFile(ctx, relPath, category, file, existing, stats, ops);
  }

  for (const leftover of existingByPath.values()) {
    ops.push(() => deleteItem(db, leftover.rel_path));
    stats.removed += 1;
  }

  runChunked(db, ops);
  return { stats, dirs };
}
