// @ts-check
import { deleteItemsUnderDir, listDirsUnderDir } from '../db/library-repo.js';

/**
 * Pure `ScanStats` accumulation plus the end-of-walk DB sweep, split out of
 * `scanner.js` purely to keep that file under the constitution's 300-line
 * limit — no behavioural difference from having these inline there.
 *
 * Spec: docs/specs/spec-library-video.md, "Scanner modules" (`scanner.js`'s
 * end-of-walk sweep and Stats contract).
 */

/** @typedef {import('./dir-sync.js').DirSyncStats} DirSyncStats */
/** @typedef {{ added: number, updated: number, removed: number, unchanged: number, failedDirs: number, skippedSymlinks: number, skippedUndecodable: number, protectedRoots: number, durationMs: number }} ScanStats */

/** @returns {ScanStats} a fresh, all-zero stats accumulator */
export function emptyStats() {
  return {
    added: 0,
    updated: 0,
    removed: 0,
    unchanged: 0,
    failedDirs: 0,
    skippedSymlinks: 0,
    skippedUndecodable: 0,
    protectedRoots: 0,
    durationMs: 0,
  };
}

/**
 * Adds one directory's `dir-sync.js` result into a running `ScanStats`
 * total.
 * @param {ScanStats} target mutated in place
 * @param {DirSyncStats} part
 * @returns {void}
 */
export function addDirStats(target, part) {
  target.added += part.added;
  target.updated += part.updated;
  target.removed += part.removed;
  target.unchanged += part.unchanged;
  target.skippedSymlinks += part.skippedSymlinks;
  target.skippedUndecodable += part.skippedUndecodable;
}

/** @param {string} dir @param {string[]} protectedPrefixes @returns {boolean} whether `dir` is, or lies under, a protected/failed prefix */
function isUnderProtected(dir, protectedPrefixes) {
  return protectedPrefixes.some((p) => dir === p || dir.startsWith(`${p}/`));
}

/**
 * Deletes rows for every DB-known directory under `rootPrefix` that the walk
 * did not visit, except under a protected/failed prefix. Shared by the full
 * scan (one call per healthy category root) and `scanSubtree` (one call
 * scoped to the reconciled directory).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} rootPrefix
 * @param {Set<string>} visited
 * @param {string[]} protectedPrefixes
 * @param {ScanStats} stats mutated in place
 * @returns {void}
 */
export function sweepPrefix(db, rootPrefix, visited, protectedPrefixes, stats) {
  for (const dir of listDirsUnderDir(db, rootPrefix)) {
    if (visited.has(dir) || isUnderProtected(dir, protectedPrefixes)) continue;
    stats.removed += deleteItemsUnderDir(db, dir);
  }
}
