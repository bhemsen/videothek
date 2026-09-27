// @ts-check
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isSkippedName } from './walk.js';
import { buildItem } from './item-builder.js';
import { upsertBuiltRow } from './dir-sync.js';
import { categoryForFolder } from './categories.js';
import { rootHealth } from './root-health.js';
import { SCAN_VERSION } from './parsers/compat.js';
import { getItemByRelPath, deleteItem, deleteItemsUnderDir } from '../db/library-repo.js';

/**
 * Reconciles a batch of `MEDIA_ROOT`-relative paths reported by change
 * detection: each path is looked at individually via `lstat` and brought in
 * line with the index, per the path-reconcile rules.
 *
 * Spec: docs/specs/spec-library-video.md, "Scanner modules" (path reconcile).
 */

/**
 * Same field set as `scanner.js`'s `ScanStats`, minus `durationMs` (measured
 * by `scanner.js`'s `runPathsReconcile`, which wraps the whole batch, not by
 * this module) — so a `'paths'` run's `onScanComplete` payload and
 * `status().lastStats` carry the same shape as every other run kind.
 * @typedef {object} ReconcileStats
 * @property {number} added
 * @property {number} updated
 * @property {number} removed
 * @property {number} unchanged
 * @property {number} failedDirs
 * @property {number} skippedSymlinks
 * @property {number} skippedUndecodable
 * @property {number} protectedRoots
 */
/**
 * @typedef {object} ReconcileCtx
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {string} mediaRoot
 * @property {() => number} now
 * @property {import('./dir-watch.js').DirWatchSet} dirObserver
 * @property {(relDir: string) => Promise<{ stats: ReconcileStats }>} scanSubtree runs the
 *   same walk scoped to `relDir`, sweeping only that prefix (`scanner.js`'s
 *   implementation returns its own full `ScanStats`, a superset of this
 *   shape). Provided by `scanner.js` so this module never imports it back
 *   (would be circular: `scanner.js` already imports `reconcile.js` for its
 *   `'paths'` runs).
 * @property {(relDir: string) => void} markTouched marks the directory of a
 *   file this reconcile confirmed or (re)indexed as visited by the full scan
 *   currently running (no-op outside one), so that scan's end-of-walk sweep
 *   never deletes it — its own walk may have listed the parent before the
 *   directory existed.
 */

/** @returns {ReconcileStats} */
function emptyStats() {
  return {
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    failedDirs: 0,
    skippedSymlinks: 0,
    skippedUndecodable: 0,
    protectedRoots: 0,
  };
}

/**
 * @param {string} relPath
 * @returns {boolean} whether `relPath` is `''` (MEDIA_ROOT) or has no `/` (a
 *   top-level entry) — either is a candidate to escalate to a full scan,
 *   since a structural change at that level can add, remove or rename a
 *   whole category root (see `canIgnoreTopLevel` for the entries that
 *   never can)
 */
function isTopLevel(relPath) {
  return relPath === '' || !relPath.includes('/');
}

/**
 * Whether a top-level path reported by change detection can be safely
 * ignored instead of escalating to a full scan: the spec restricts
 * escalation to "MEDIA_ROOT itself or a top-level *folder*" — a hidden/known
 * NAS-or-OS name, or a plain file (never a category root, which is always a
 * directory), matches neither. `MEDIA_ROOT` itself (`relPath === ''`) always
 * escalates: only a full `discoverRoots()` listing can tell what changed
 * directly inside it.
 * @param {string} mediaRoot
 * @param {string} relPath non-empty, single-segment (checked by the caller)
 * @returns {Promise<boolean>}
 */
async function canIgnoreTopLevel(mediaRoot, relPath) {
  if (isSkippedName(relPath)) return true;
  try {
    return (await lstat(join(mediaRoot, relPath))).isFile();
  } catch {
    return false; // missing or unreadable: a category root may have been removed/broken
  }
}

/**
 * Deletes any row for `relPath` and any rows nested under it, bumping
 * `stats.removed` at most once.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} relPath
 * @param {ReconcileStats} stats mutated in place
 * @returns {void}
 */
function deletePathAndSubtree(db, relPath, stats) {
  const removedItem = deleteItem(db, relPath);
  const removedSubtree = deleteItemsUnderDir(db, relPath) > 0;
  if (removedItem || removedSubtree) stats.removed += 1;
}

/**
 * Whether any `/`-separated segment of `relPath` — not just its last one —
 * is unsafe (`''`, `.` or `..`, which would escape containment), a skipped
 * name, or contains U+FFFD (undecodable; the walk skips those too, so
 * indexing one here would flip-flop with every full scan). A watcher can report a path such as `Filme/.hidden/x.mp4` or
 * `Filme/@eaDir/x.mp4` (an ancestor, not the entry itself, matches the skip
 * rules); the whole path must then be treated as skipped — never indexed,
 * never descended into — matching the walk, which never lists a skipped
 * directory's contents in the first place.
 * @param {string} relPath
 * @returns {boolean}
 */
function hasUnsafeOrSkippedSegment(relPath) {
  return relPath
    .split('/')
    .some((seg) => seg === '' || seg === '.' || seg === '..' || seg.includes('�') || isSkippedName(seg));
}

/**
 * Handles a path whose `lstat` came back `ENOENT`. An unhealthy category
 * root (missing, unreadable or empty — see `root-health.js`) escalates to a
 * full scan, which owns the root-safety bookkeeping; nothing is deleted here.
 * @param {ReconcileCtx} ctx
 * @param {string} relPath
 * @param {string} rootName
 * @param {ReconcileStats} stats
 * @returns {Promise<boolean>} whether to escalate to a full scan
 */
async function reconcileMissing(ctx, relPath, rootName, stats) {
  if ((await rootHealth(ctx.mediaRoot, rootName)) !== null) {
    return true;
  }
  deletePathAndSubtree(ctx.db, relPath, stats);
  ctx.dirObserver.gone(relPath);
  return false;
}

/**
 * Handles a path whose `lstat` succeeded and is a regular file: rebuilds and
 * upserts it unless size/mtime/`scan_version` are unchanged, matching
 * `dir-sync.js`'s diff rule for a single already-known path.
 * @param {ReconcileCtx} ctx
 * @param {string} relPath
 * @param {string} category
 * @param {import('node:fs').Stats} stat
 * @param {ReconcileStats} stats
 * @returns {Promise<void>}
 */
async function reconcileFile(ctx, relPath, category, stat, stats) {
  const existing = getItemByRelPath(ctx.db, relPath);
  const dir = relPath.slice(0, relPath.lastIndexOf('/'));
  if (
    existing &&
    existing.size === stat.size &&
    existing.mtime_ms === Math.trunc(stat.mtimeMs) &&
    existing.scan_version === SCAN_VERSION
  ) {
    stats.unchanged += 1;
    ctx.markTouched(dir);
    return;
  }
  const row = await buildItem({
    mediaRoot: ctx.mediaRoot,
    relPath,
    category: /** @type {import('./item-builder.js').BuildItemInput['category']} */ (category),
    stat,
    now: ctx.now,
  });
  if (!row) {
    if (existing && deleteItem(ctx.db, relPath)) stats.removed += 1;
    return;
  }
  upsertBuiltRow(ctx.db, row, ctx.now());
  ctx.markTouched(dir);
  stats[existing ? 'updated' : 'added'] += 1;
}

/**
 * Reconciles one path already known to lie under a category root.
 * @param {ReconcileCtx} ctx
 * @param {string} relPath
 * @param {string} rootName
 * @param {string} category
 * @param {ReconcileStats} stats
 * @returns {Promise<boolean>} whether to escalate to a full scan
 */
async function reconcileOne(ctx, relPath, rootName, category, stats) {
  if (hasUnsafeOrSkippedSegment(relPath)) {
    deletePathAndSubtree(ctx.db, relPath, stats);
    ctx.dirObserver.gone(relPath);
    return false;
  }

  /** @type {import('node:fs').Stats} */
  let st;
  try {
    st = await lstat(join(ctx.mediaRoot, ...relPath.split('/')));
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
      return reconcileMissing(ctx, relPath, rootName, stats);
    }
    return false; // any other lstat error: keep rows, the periodic scan repairs it
  }

  if (st.isSymbolicLink()) {
    deletePathAndSubtree(ctx.db, relPath, stats);
    ctx.dirObserver.gone(relPath);
    return false;
  }
  if (st.isDirectory()) {
    const { stats: sub } = await ctx.scanSubtree(relPath);
    stats.added += sub.added;
    stats.updated += sub.updated;
    stats.removed += sub.removed;
    stats.unchanged += sub.unchanged;
    stats.failedDirs += sub.failedDirs;
    stats.skippedSymlinks += sub.skippedSymlinks;
    stats.skippedUndecodable += sub.skippedUndecodable;
    stats.protectedRoots += sub.protectedRoots;
    return false;
  }
  if (st.isFile()) {
    await reconcileFile(ctx, relPath, category, st, stats);
  }
  return false;
}

/**
 * @param {ReconcileCtx} ctx
 * @param {string[]} relPaths coalesced batch of `MEDIA_ROOT`-relative paths
 * @returns {Promise<{ stats: ReconcileStats, escalate: boolean }>}
 */
export async function reconcilePaths(ctx, relPaths) {
  const stats = emptyStats();
  let escalate = false;

  for (const relPath of relPaths) {
    if (isTopLevel(relPath)) {
      if (relPath !== '' && (await canIgnoreTopLevel(ctx.mediaRoot, relPath))) continue;
      escalate = true;
      continue;
    }
    const rootName = relPath.slice(0, relPath.indexOf('/'));
    const category = categoryForFolder(rootName);
    if (!category) continue; // outside every category root

    if (await reconcileOne(ctx, relPath, rootName, category, stats)) escalate = true;
  }

  return { stats, escalate };
}
