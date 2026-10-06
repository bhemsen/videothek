// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import { upsertItem } from '../../src/db/library-repo.js';
import { storageKey } from '../../src/convert/targets.js';
import { makeDb, makeTempDir, fakeLogger, fakeConfig } from './conversion-queue-fixtures.js';

/**
 * Shared fixtures for the cleanup pass tests: a real temp `MEDIA_ROOT` and
 * `CONVERT_DIR`, an in-memory DB, and helpers that create a conversion row,
 * its source file, its `library_items` row and its copy directory.
 */

export const DAY_MS = 24 * 60 * 60 * 1000;
export const NOW = 100 * DAY_MS;

/**
 * @param {import('node:test').TestContext} t
 */
export async function cleanupFixture(t) {
  const db = makeDb();
  t.after(() => { if (db.isOpen) db.close(); });
  const mediaRoot = await makeTempDir(t, 'vt-cleanup-media-');
  const convertDirReal = await makeTempDir(t, 'vt-cleanup-convert-');
  const { log, calls } = fakeLogger();
  /** @type {string[]} */
  const removed = [];
  const removeDir = async (/** @type {string} */ target) => {
    removed.push(target);
    await fs.rm(target, { recursive: true, force: true });
  };
  const state = { stopping: false };
  /** @param {Partial<import('../../src/convert/cleanup.js').CleanupContext>} [overrides] */
  const ctx = (overrides = {}) => ({
    db, mediaRoot, convertDirReal, removeDir, log, now: () => NOW, isStopping: () => state.stopping, ...overrides,
  });
  return { db, mediaRoot, convertDirReal, log, calls, removed, removeDir, state, ctx, config: fakeConfig(mediaRoot, convertDirReal) };
}

/**
 * @param {Awaited<ReturnType<typeof cleanupFixture>>} f
 * @param {string} relPath
 * @param {{ size?: number, mtimeMs?: number, playable?: boolean, write?: boolean }} [opts] - `write: false` keeps an existing source file untouched
 * @returns {Promise<{ size: number, mtimeMs: number }>} the source stat the item row records
 */
export async function addItem(f, relPath, opts = {}) {
  const abs = path.join(f.mediaRoot, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  if (opts.write !== false) await fs.writeFile(abs, 'source bytes');
  const stat = await fs.stat(abs);
  const size = opts.size ?? stat.size;
  const mtimeMs = opts.mtimeMs ?? Math.trunc(stat.mtimeMs);
  upsertItem(
    f.db,
    {
      rel_path: relPath, dir: path.dirname(relPath), category: 'audiobooks', kind: 'audio', ext: 'mp3',
      title: relPath, sort_title: relPath, playable: opts.playable ?? false, size, mtime_ms: mtimeMs, scan_version: 1,
    },
    1000
  );
  return { size, mtimeMs };
}

/**
 * Inserts a `conversions` row directly.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} relPath
 * @param {{ status?: string, sourceSize?: number, sourceMtimeMs?: number, outputRel?: string | null, missingSince?: number | null, sidecars?: string }} [o]
 * @returns {string} the storage key
 */
export function addConversion(db, relPath, o = {}) {
  const key = storageKey(relPath);
  db.prepare(
    `INSERT INTO conversions (rel_path, storage_key, target, status, source_size, source_mtime_ms,
       output_rel, output_size, sidecars, missing_since, queued_at)
     VALUES (?, ?, 'flac', ?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(
    relPath, key, o.status ?? 'playable', o.sourceSize ?? 1, o.sourceMtimeMs ?? 1,
    o.outputRel === undefined ? `${key}/audio.flac` : o.outputRel, o.outputRel === null ? null : 4,
    o.sidecars ?? '[]', o.missingSince ?? null
  );
  return key;
}

/**
 * Writes `<convertDirReal>/<key>/<file>` (and a sidecar).
 * @param {string} convertDirReal
 * @param {string} key
 * @param {string} [file]
 */
export async function writeCopy(convertDirReal, key, file = 'audio.flac') {
  await fs.mkdir(path.join(convertDirReal, key), { recursive: true });
  await fs.writeFile(path.join(convertDirReal, key, file), 'fLaC');
  await fs.writeFile(path.join(convertDirReal, key, 'sub-0.vtt'), 'WEBVTT');
}

/**
 * A fresh playable copy: real source, matching item row (flag 1 through the
 * fresh conversion), conversion row and copy directory.
 * @param {Awaited<ReturnType<typeof cleanupFixture>>} f
 * @param {string} relPath
 * @returns {Promise<{ key: string, size: number, mtimeMs: number }>}
 */
export async function addPlayableCopy(f, relPath) {
  const abs = path.join(f.mediaRoot, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, 'source bytes');
  const stat = await fs.stat(abs);
  const mtimeMs = Math.trunc(stat.mtimeMs);
  const key = addConversion(f.db, relPath, { sourceSize: stat.size, sourceMtimeMs: mtimeMs });
  await addItem(f, relPath, { write: false });
  await writeCopy(f.convertDirReal, key);
  return { key, size: stat.size, mtimeMs };
}

/**
 * @param {string} p
 * @returns {Promise<boolean>}
 */
export async function exists(p) {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} relPath
 * @returns {{ playable: number, scan_version: number } | undefined}
 */
export function itemFlags(db, relPath) {
  return /** @type {any} */ (db.prepare('SELECT playable, scan_version FROM library_items WHERE rel_path = ?').get(relPath));
}
