// @ts-check
import { lstat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { isSkippedName, listDirectory } from './walk.js';
import { buildItem } from './item-builder.js';
import { upsertBuiltRow } from './dir-sync.js';
import { categoryForFolder } from './categories.js';
import { SCAN_VERSION } from './parsers/compat.js';
import { getItemsByDir, deleteItem, deleteItemsUnderDir } from '../db/library-repo.js';

/**
 * Reconciles a batch of `MEDIA_ROOT`-relative paths reported by change
 * detection: each path is looked at individually via `lstat` and brought in
 * line with the index, per the path-reconcile rules.
 *
 * Spec: docs/specs/spec-library-video.md, "Scanner modules" (path reconcile).
 */

/** @typedef {import('./dir-sync.js').DirSyncStats} SubtreeStats */
/**
 * @typedef {object} ReconcileStats
 * @property {number} added
 * @property {number} updated
 * @property {number} removed
 * @property {number} unchanged
 */
/**
 * @typedef {object} ReconcileCtx
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {string} mediaRoot
 * @property {() => number} now
 * @property {import('./dir-watch.js').DirWatchSet} dirObserver
 * @property {(relDir: string) => Promise<{ stats: SubtreeStats }>} scanSubtree runs the
 *   same walk scoped to `relDir`, sweeping only that prefix. Provided by
 *   `scanner.js` so this module never imports it back (would be circular:
 *   `scanner.js` already imports `reconcile.js` for its `'paths'` runs).
 */

/** @returns {ReconcileStats} */
function emptyStats() {
  return { added: 0, updated: 0, removed: 0, unchanged: 0 };
}

/**
 * @param {string} relPath
 * @returns {boolean} whether `relPath` is `''` (MEDIA_ROOT) or has no `/` (a
 *   top-level entry) — either escalates to a full scan, since a structural
 *   change at that level can add, remove or rename a whole category root
 */
function isTopLevel(relPath) {
  return relPath === '' || !relPath.includes('/');
}

/**
 * Whether the category root owning a reconciled path is currently healthy
 * (readable and non-empty). Used only to decide the ENOENT case below; it
 * never itself protects rows or logs anything — an unhealthy root always
 * escalates to a full scan, which owns the real root-safety bookkeeping.
 * @param {string} mediaRoot
 * @param {string} rootName exact on-disk name of the category-root segment
 * @returns {Promise<boolean>}
 */
async function isRootHealthy(mediaRoot, rootName) {
  try {
    const { files, dirs } = await listDirectory(join(mediaRoot, rootName));
    return files.length + dirs.length > 0;
  } catch {
    return false;
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
 * Handles a path whose `lstat` came back `ENOENT`.
 * @param {ReconcileCtx} ctx
 * @param {string} relPath
 * @param {string} rootName
 * @param {ReconcileStats} stats
 * @returns {Promise<boolean>} whether to escalate to a full scan
 */
async function reconcileMissing(ctx, relPath, rootName, stats) {
  if (!(await isRootHealthy(ctx.mediaRoot, rootName))) {
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
  const dir = relPath.slice(0, relPath.lastIndexOf('/'));
  const existing = getItemsByDir(ctx.db, dir).find((row) => row.rel_path === relPath);
  if (
    existing &&
    existing.size === stat.size &&
    existing.mtime_ms === Math.trunc(stat.mtimeMs) &&
    existing.scan_version === SCAN_VERSION
  ) {
    stats.unchanged += 1;
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

  if (st.isSymbolicLink() || isSkippedName(basename(relPath))) {
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
