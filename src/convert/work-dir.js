// @ts-check

/**
 * `CONVERT_DIR` setup, crash-recovery wipe, and per-job/per-publish directory
 * handling for on-demand conversion (`docs/specs/spec-conversion-core.md`,
 * "Queue", `start()` steps 1-6 and the job's steps 3 and 6). Pure filesystem
 * I/O behind small result objects (`{ ok: true, ... } | { ok: false, code }`)
 * — no DB, no logging, no process spawning; the queue interprets `code` into
 * its own log lines and failure codes (`conversion_dir_unavailable`,
 * `storage_failed`).
 */

import path from 'node:path';
import { lstat, mkdir, mkdtemp, realpath, rm, unlink } from 'node:fs/promises';
import { isInside } from '../config-converter.js';

/**
 * The crash work area's fixed name under `CONVERT_DIR`, distinctive so a
 * `CONVERT_DIR` pointed at an existing shared directory never loses an
 * unrelated `.work` folder (`start()` removes it recursively).
 */
export const WORK_AREA_NAME = '.videothek-work';

/** @typedef {(target: string) => Promise<void>} RemoveDir */

/**
 * @typedef {{ ok: true, convertDirReal: string } | { ok: false, code: string }} SetupResult
 */
/** @typedef {{ ok: true } | { ok: false, code: string }} WipeResult */
/**
 * @typedef {{ ok: true, jobDir: string, outDir: string, tmpDir: string }
 *   | { ok: false, code: string, jobDir?: string }} JobDirResult
 *   `jobDir` is present on failure only once `mkdtemp` itself succeeded, so
 *   the caller still knows what its own `finally` must pass to `removeDir`.
 */
/** @typedef {{ ok: true, publishDirReal: string } | { ok: false, code: string }} PublishDirResult */

/** Default `removeDir`: the one recursive-removal shape used everywhere in the spec. */
const defaultRemoveDir = (/** @type {string} */ target) =>
  rm(target, { recursive: true, force: true, maxRetries: 3 });

/**
 * Sets up `CONVERT_DIR` for the conversion queue (`start()` steps 1-6):
 * realpath's `mediaRoot`, walks up from `convertDir` to its nearest existing
 * ancestor and realpath's that, checks the resulting candidate against
 * `mediaRoot` (both directions) and `publicDir` before creating anything,
 * `mkdir -p`s only once both pass, then repeats both checks on the created
 * directory's own realpath. On success also wipes the crash work area.
 * @param {object} params
 * @param {string} params.mediaRoot - configured, absolute `MEDIA_ROOT`.
 * @param {string} params.convertDir - configured, absolute `CONVERT_DIR`.
 * @param {string} params.publicDir - absolute app `public/` directory.
 * @param {RemoveDir} [params.removeDir] - injectable seam, also used by the
 *   work-area wipe; defaults to `fs.rm` with the spec's recursive options.
 * @returns {Promise<SetupResult>} `convertDirReal` on success, else a
 *   failure `code`: an errno code, `'overlap'` or `'public'`.
 */
export async function setupConvertDir({ mediaRoot, convertDir, publicDir, removeDir = defaultRemoveDir }) {
  let mediaRootReal;
  let publicDirReal;
  try {
    [mediaRootReal, publicDirReal] = await Promise.all([realpath(mediaRoot), realpath(publicDir)]);
  } catch (err) {
    return { ok: false, code: errorCode(err) };
  }

  const ancestor = await nearestExistingAncestorReal(convertDir);
  if (!ancestor.ok) return ancestor;
  const candidate = path.join(ancestor.real, ...ancestor.missing);
  const firstOverlap = checkOverlap(candidate, mediaRootReal, publicDirReal);
  if (!firstOverlap.ok) return firstOverlap;

  try {
    await mkdir(convertDir, { recursive: true });
  } catch (err) {
    return { ok: false, code: errorCode(err) };
  }

  let convertDirReal;
  try {
    convertDirReal = await realpath(convertDir);
  } catch (err) {
    return { ok: false, code: errorCode(err) };
  }
  const secondOverlap = checkOverlap(convertDirReal, mediaRootReal, publicDirReal);
  if (!secondOverlap.ok) return secondOverlap;

  const wipe = await wipeWorkArea(convertDirReal, removeDir);
  if (!wipe.ok) return wipe;
  return { ok: true, convertDirReal };
}

/**
 * Removes leftovers of a crashed run (`start()` step 6). The work area is
 * `lstat`'d first, with no trailing separator (a trailing separator would
 * make `lstat`/`fs.rm` follow a planted symlink or junction on POSIX): a
 * real directory is passed whole to `removeDir`, anything else (symlink,
 * Windows junction, regular file) is only `unlink`ed, which removes just the
 * link entry and never recurses into its target.
 * @param {string} convertDirReal - realpath from `setupConvertDir`.
 * @param {RemoveDir} [removeDir]
 * @returns {Promise<WipeResult>}
 */
export async function wipeWorkArea(convertDirReal, removeDir = defaultRemoveDir) {
  const workArea = path.join(convertDirReal, WORK_AREA_NAME);
  let stat;
  try {
    stat = await lstat(workArea);
  } catch (err) {
    const code = errorCode(err);
    return code === 'ENOENT' ? { ok: true } : { ok: false, code };
  }
  try {
    await (stat.isDirectory() ? removeDir(workArea) : unlink(workArea));
    return { ok: true };
  } catch (err) {
    return { ok: false, code: errorCode(err) };
  }
}

/**
 * Creates one job attempt's work directory (Queue "Job" step 3): re-creates
 * and verifies the shared `.videothek-work` area under `convertDirReal`
 * (which `start()`'s wipe removed and nothing else re-creates) before
 * creating anything inside it — this catches a `.videothek-work` symlink or
 * junction planted in advance, including one that points elsewhere inside
 * `CONVERT_DIR` (a plain containment check would accept that) — then a fresh
 * unique job dir via `mkdtemp`, plus its `out/` and `tmp/` subdirectories.
 * @param {object} params
 * @param {string} params.convertDirReal - realpath from `setupConvertDir`.
 * @param {string} params.storageKey - hex `storage_key`, the `mkdtemp` prefix.
 * @param {NodeJS.Platform} [params.platform] - drives case-insensitive
 *   containment matching on `win32`, byte-exact elsewhere; default
 *   `process.platform` (pattern of `redactDetail`).
 * @returns {Promise<JobDirResult>}
 */
export async function createJobDir({ convertDirReal, storageKey, platform = process.platform }) {
  const workArea = path.join(convertDirReal, WORK_AREA_NAME);
  try {
    await mkdir(workArea, { recursive: true });
  } catch (err) {
    return { ok: false, code: errorCode(err) };
  }

  let workAreaReal;
  try {
    workAreaReal = await realpath(workArea);
  } catch (err) {
    return { ok: false, code: errorCode(err) };
  }
  if (!isExactly(workArea, workAreaReal, platform)) return { ok: false, code: 'containment' };

  let jobDir;
  try {
    jobDir = await mkdtemp(path.join(workAreaReal, `${storageKey}-`));
  } catch (err) {
    return { ok: false, code: errorCode(err) };
  }
  return createJobSubdirs(jobDir);
}

/**
 * Creates `out/` and `tmp/` inside a fresh job directory (the tail of Queue
 * "Job" step 3). Exported so its failure contract is testable: a failure
 * here still carries `jobDir`, so the caller's `finally` can remove it.
 * @param {string} jobDir - the `mkdtemp`-created job directory.
 * @returns {Promise<JobDirResult>}
 */
export async function createJobSubdirs(jobDir) {
  const outDir = path.join(jobDir, 'out');
  const tmpDir = path.join(jobDir, 'tmp');
  try {
    await mkdir(outDir);
    await mkdir(tmpDir);
    return { ok: true, jobDir, outDir, tmpDir };
  } catch (err) {
    return { ok: false, code: errorCode(err), jobDir };
  }
}

/**
 * Prepares one conversion's publish directory (Queue "Job" step 6):
 * `mkdir`s `CONVERT_DIR/<storage_key>` and requires its realpath to equal
 * that exact path, so a pre-planted symlink or junction there — including
 * one into `.videothek-work/<job>`, whose own removal would otherwise delete
 * the published copy — is rejected instead of published into.
 * @param {object} params
 * @param {string} params.convertDirReal - realpath from `setupConvertDir`.
 * @param {string} params.storageKey - hex `storage_key` directory name.
 * @param {NodeJS.Platform} [params.platform] - see `createJobDir`.
 * @returns {Promise<PublishDirResult>}
 */
export async function preparePublishDir({ convertDirReal, storageKey, platform = process.platform }) {
  const publishDir = path.join(convertDirReal, storageKey);
  try {
    await mkdir(publishDir, { recursive: true });
  } catch (err) {
    return { ok: false, code: errorCode(err) };
  }

  let publishDirReal;
  try {
    publishDirReal = await realpath(publishDir);
  } catch (err) {
    return { ok: false, code: errorCode(err) };
  }
  if (!isExactly(publishDir, publishDirReal, platform)) return { ok: false, code: 'containment' };
  return { ok: true, publishDirReal };
}

/**
 * Walks up from `dir` to the nearest ancestor that `lstat` succeeds on (a
 * dangling symlink counts as existing) and realpath's that ancestor. A
 * non-`ENOENT` `lstat` failure partway up (e.g. `EACCES`, or `ENOTDIR` when a
 * path segment is actually a file) stops the walk immediately rather than
 * treating it as "missing".
 * @param {string} dir
 * @returns {Promise<{ ok: true, real: string, missing: string[] } | { ok: false, code: string }>}
 */
async function nearestExistingAncestorReal(dir) {
  let current = dir;
  /** @type {string[]} */
  const missing = [];
  for (;;) {
    try {
      await lstat(current);
      break;
    } catch (err) {
      const code = errorCode(err);
      if (code !== 'ENOENT') return { ok: false, code };
      const parent = path.dirname(current);
      if (parent === current) return { ok: false, code };
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
  try {
    return { ok: true, real: await realpath(current), missing };
  } catch (err) {
    return { ok: false, code: errorCode(err) };
  }
}

/**
 * @param {string} candidate
 * @param {string} mediaRootReal
 * @param {string} publicDirReal
 * @returns {{ ok: true } | { ok: false, code: 'overlap' | 'public' }}
 */
function checkOverlap(candidate, mediaRootReal, publicDirReal) {
  if (isInside(mediaRootReal, candidate) || isInside(candidate, mediaRootReal)) {
    return { ok: false, code: 'overlap' };
  }
  if (isInside(publicDirReal, candidate)) return { ok: false, code: 'public' };
  return { ok: true };
}

/**
 * Whether `actual` (a realpath) is exactly `expected`, not merely inside it —
 * case-insensitively and separator-agnostically on `win32` (matching that
 * filesystem), byte-exact elsewhere. Uses the platform's own `path.relative`
 * rather than `toLowerCase()`, driven by `platform` (not the host OS), so
 * this is testable for both platforms from either dev machine (pattern of
 * `redactDetail`/`resolveMediaPath`).
 * @param {string} expected
 * @param {string} actual
 * @param {NodeJS.Platform} platform
 * @returns {boolean}
 */
function isExactly(expected, actual, platform) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  return p.relative(expected, actual) === '';
}

/**
 * @param {unknown} err
 * @returns {string} the errno `code`, else the error's `name`, else `'ERR_UNKNOWN'`.
 */
function errorCode(err) {
  const code = /** @type {{ code?: unknown }} */ (err)?.code;
  if (typeof code === 'string') return code;
  const name = /** @type {{ name?: unknown }} */ (err)?.name;
  return typeof name === 'string' ? name : 'ERR_UNKNOWN';
}
