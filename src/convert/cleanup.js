// @ts-check

/**
 * Filesystem side of the queue-owned cleanup pass
 * (`docs/specs/spec-converter-adapter.md`, "Cleanup rules"); the SQL lives in
 * `src/db/conversion-cleanup.js`. Every rule changes the DB first and removes
 * the directory second. Deletes only 64-lowercase-hex directories directly
 * under the realpath'd `CONVERT_DIR` that `lstat` reports as real directories
 * (never a symlink or junction, never `.videothek-work/` or any other name),
 * through the queue's injectable `removeDir`. Only `ENOENT` counts as
 * "missing"; any other `stat`/`readdir`/`lstat`/removal error aborts the rest
 * of the pass with `conversion_cleanup_failed { code }`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveMediaPath } from '../media/paths.js';
import { errorCode } from './error-code.js';
import {
  syncMissingSince, listExpiredMissing, deleteExpiredMissing, listPlayableWithItem,
  deletePlayableAndResetItem, listFailedWithOutput, stripFailedOutput, listFreshPlayable,
  listWithOutput, isKeyReferenced,
} from '../db/conversion-cleanup.js';

/** @typedef {import('node:sqlite').DatabaseSync} DatabaseSync */
/** @typedef {import('./work-dir.js').RemoveDir} RemoveDir */

/** Fixed grace period for a vanished source (spec decision, no env var). */
export const VANISHED_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

const HEX_KEY = /^[0-9a-f]{64}$/;

/**
 * @typedef {object} CleanupContext
 * @property {DatabaseSync} db
 * @property {string} mediaRoot
 * @property {string} convertDirReal - the realpath'd `CONVERT_DIR` (from the queue's `start()`).
 * @property {RemoveDir} removeDir
 * @property {import('../log.js').Logger} log
 * @property {() => number} now
 * @property {() => boolean} isStopping - checked between rules and between directory removals.
 */

/**
 * @typedef {object} CleanupStats
 * @property {number} purged - rows deleted by rules 2 (vanished > 30 days) and 3 (stale copy)
 * @property {number} stripped - failed rows whose leftover output was cleared (rule 4)
 * @property {number} reconciled - fresh rows whose copy file was gone (rule 5)
 * @property {number} orphans - unreferenced hex directories removed (rule 6)
 * @property {number} missing - rows newly marked `missing_since` (rule 1)
 */

class CleanupStopped extends Error {}

/** @param {CleanupContext} ctx */
function checkStop(ctx) {
  if (ctx.isStopping()) throw new CleanupStopped('stopping');
}

/** @param {unknown} err */
const isEnoent = (err) => /** @type {{ code?: unknown }} */ (err)?.code === 'ENOENT';

/**
 * Removes `<convertDirReal>/<key>` after re-checking it is a real directory
 * (lstat: a symlink or junction named like a key is never followed or removed).
 * @param {CleanupContext} ctx
 * @param {string} key
 * @returns {Promise<boolean>} whether a directory was removed
 */
async function removeKeyDir(ctx, key) {
  if (!HEX_KEY.test(key)) return false;
  const target = path.join(ctx.convertDirReal, key);
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
  if (!stat.isDirectory()) return false;
  checkStop(ctx);
  await ctx.removeDir(target);
  return true;
}

/**
 * @param {{ storage_key: string, output_rel: string | null }} row
 * @param {string} convertDirReal
 * @returns {string | null} the copy's path, or `null` for a malformed `output_rel` (not `<key>/<file>`)
 */
function copyPath(row, convertDirReal) {
  const parts = (row.output_rel ?? '').split('/');
  const [key, file] = parts;
  if (parts.length !== 2 || key !== row.storage_key || !HEX_KEY.test(key) || !file) return null;
  if (file === '.' || file === '..' || /[\\:\0]/.test(file)) return null;
  return path.join(convertDirReal, key, file);
}

/**
 * @param {string} file
 * @returns {Promise<boolean>} `false` only for `ENOENT`; any other error propagates
 */
async function statExists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err;
  }
}

/**
 * @param {string} convertDirReal
 * @returns {Promise<string[]>} names of the real 64-hex directories directly under it (`ENOENT` -> none)
 */
async function listHexDirs(convertDirReal) {
  try {
    const entries = await fs.readdir(convertDirReal, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && HEX_KEY.test(e.name)).map((e) => e.name);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

/**
 * Rule 2: rows missing for more than the grace period, then their directory.
 * @param {CleanupContext} ctx
 * @param {CleanupStats} stats - `purged` is incremented as rows go (survives an abort)
 * @returns {Promise<void>}
 */
async function ruleVanished(ctx, stats) {
  const cutoff = ctx.now() - VANISHED_GRACE_MS;
  for (const row of listExpiredMissing(ctx.db, cutoff)) {
    checkStop(ctx);
    if (!deleteExpiredMissing(ctx.db, row.rel_path, cutoff)) continue;
    stats.purged += 1;
    await removeKeyDir(ctx, row.storage_key);
  }
}

/**
 * Rule 3: `playable` rows whose on-disk source (not `library_items`) no
 * longer matches the recorded size/mtime. A source that cannot be resolved or
 * answers `ENOENT` is left to rules 1/2 (also covers a protected root).
 * @param {CleanupContext} ctx
 * @param {CleanupStats} stats - `purged` is incremented as rows go (survives an abort)
 * @returns {Promise<void>}
 */
async function ruleStale(ctx, stats) {
  for (const row of listPlayableWithItem(ctx.db)) {
    checkStop(ctx);
    const source = await resolveMediaPath(ctx.mediaRoot, row.rel_path);
    if (source === null) continue;
    let stat;
    try {
      stat = await fs.stat(source);
    } catch (err) {
      if (isEnoent(err)) continue;
      throw err;
    }
    if (stat.size === row.source_size && Math.trunc(stat.mtimeMs) === row.source_mtime_ms) continue;
    if (!deletePlayableAndResetItem(ctx.db, row.rel_path, row.storage_key)) continue;
    stats.purged += 1;
    await removeKeyDir(ctx, row.storage_key);
  }
}

/**
 * Rule 4: `failed` rows keep no copy reference; their directory goes.
 * @param {CleanupContext} ctx
 * @param {CleanupStats} stats - `stripped` is incremented as rows go
 * @returns {Promise<void>}
 */
async function ruleFailedLeftovers(ctx, stats) {
  for (const row of listFailedWithOutput(ctx.db)) {
    checkStop(ctx);
    if (!stripFailedOutput(ctx.db, row.rel_path)) continue;
    stats.stripped += 1;
    await removeKeyDir(ctx, row.storage_key);
  }
}

/**
 * Unmounted-disk guard: with rows that record a copy, an empty `CONVERT_DIR`
 * (no hex directory) or not a single existing referenced copy file means the
 * disk is probably not mounted; rules 5 and 6 must not run.
 * @param {CleanupContext} ctx
 * @returns {Promise<string | null>} the skip reason, or `null` when safe
 */
async function unmountedDiskReason(ctx) {
  const rows = listWithOutput(ctx.db);
  if (rows.length === 0) return null;
  if ((await listHexDirs(ctx.convertDirReal)).length === 0) return 'convert_dir_empty';
  for (const row of rows) {
    const file = copyPath(row, ctx.convertDirReal);
    if (file !== null && (await statExists(file))) return null;
  }
  return 'no_copy_found';
}

/**
 * Rule 5: fresh `playable` rows whose copy file is gone (`ENOENT` only).
 * @param {CleanupContext} ctx
 * @param {CleanupStats} stats - `reconciled` is incremented as rows go
 * @returns {Promise<void>}
 */
async function ruleMissingCopies(ctx, stats) {
  for (const row of listFreshPlayable(ctx.db)) {
    checkStop(ctx);
    const file = copyPath(row, ctx.convertDirReal);
    if (file === null || (await statExists(file))) continue;
    if (!deletePlayableAndResetItem(ctx.db, row.rel_path, row.storage_key)) continue;
    stats.reconciled += 1;
    await removeKeyDir(ctx, row.storage_key);
  }
}

/**
 * Rule 6: unreferenced 64-hex real directories directly under `CONVERT_DIR`.
 * @param {CleanupContext} ctx
 * @param {CleanupStats} stats - `orphans` is incremented as directories go
 * @returns {Promise<void>}
 */
async function ruleOrphans(ctx, stats) {
  for (const name of await listHexDirs(ctx.convertDirReal)) {
    checkStop(ctx);
    if (isKeyReferenced(ctx.db, name)) continue;
    if (await removeKeyDir(ctx, name)) stats.orphans += 1;
  }
}

/**
 * Runs rules 1-6 in order. Never throws: a stop request ends the pass quietly
 * (changes so far are logged), any other error logs
 * `conversion_cleanup_failed { code }` and abandons the remaining rules. Logs
 * `conversion_cleanup { purged, stripped, reconciled, orphans, missing }` when
 * anything changed and `conversion_cleanup_skipped { reason }` when the
 * unmounted-disk guard skipped rules 5 and 6.
 * @param {CleanupContext} ctx
 * @returns {Promise<CleanupStats>}
 */
export async function runCleanup(ctx) {
  /** @type {CleanupStats} */
  const stats = { purged: 0, stripped: 0, reconciled: 0, orphans: 0, missing: 0 };
  try {
    checkStop(ctx);
    stats.missing = syncMissingSince(ctx.db, ctx.now()).marked;
    checkStop(ctx);
    await ruleVanished(ctx, stats);
    checkStop(ctx);
    await ruleStale(ctx, stats);
    checkStop(ctx);
    await ruleFailedLeftovers(ctx, stats);
    checkStop(ctx);
    const reason = await unmountedDiskReason(ctx);
    if (reason !== null) {
      ctx.log.warn('conversion_cleanup_skipped', { reason });
    } else {
      await ruleMissingCopies(ctx, stats);
      checkStop(ctx);
      await ruleOrphans(ctx, stats);
    }
  } catch (err) {
    if (!(err instanceof CleanupStopped)) ctx.log.error('conversion_cleanup_failed', { code: errorCode(err) });
  }
  if (Object.values(stats).some((n) => n > 0)) ctx.log.info('conversion_cleanup', { ...stats });
  return stats;
}
