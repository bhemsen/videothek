import fs from 'node:fs/promises';
import path from 'node:path';

const DRIVE_PREFIX_RE = /^[a-zA-Z]:/;

/**
 * Resolves a client-supplied path relative to `mediaRoot` and verifies it
 * stays inside it, per the constitution's path-containment rule.
 *
 * Rejects up front any `relPath` that is empty, contains a NUL byte, is
 * absolute in POSIX or Windows form (including a UNC path or a Windows
 * drive-relative path such as `C:foo`), has any `..` segment, or — on
 * win32, where a colon anywhere in the path can select an NTFS alternate
 * data stream (e.g. `sub/C:evil`, `movie.mp4:Zone.Identifier`) — contains a
 * `:` at all. The remaining candidate is resolved against `mediaRoot` and
 * both are `realpath`d (concurrently), so a symlink or junction that
 * escapes the root — or one whose target simply does not exist — is
 * rejected too. Stateless: `mediaRoot` is re-resolved on every call instead
 * of being cached.
 *
 * @param {string} mediaRoot - Absolute path to the media root directory.
 * @param {string} relPath - Client-supplied path, relative to `mediaRoot`.
 * @param {{ platform?: string }} [options] - `platform` defaults to
 *   `process.platform` and is injectable for tests instead of mutating the
 *   global.
 * @returns {Promise<string | null>} The resolved absolute path inside
 *   `mediaRoot`, or `null` when `relPath` is unsafe, escapes the root, or
 *   cannot be resolved (missing file, permission error, etc.).
 */
export async function resolveMediaPath(mediaRoot, relPath, { platform = process.platform } = {}) {
  return resolveMediaPathStrict(mediaRoot, relPath, { platform }).catch(() => null);
}

/**
 * Like {@link resolveMediaPath}, but surfaces why resolving failed: an unsafe
 * or escaping path and a missing file (`ENOENT`/`ENOTDIR`) yield `null`,
 * any other errno (`EACCES`, `EIO`, ...) is rethrown. Used by the cleanup
 * pass, where only a missing source may be treated as missing.
 *
 * @param {string} mediaRoot
 * @param {string} relPath
 * @param {{ platform?: string }} [options]
 * @returns {Promise<string | null>}
 */
export async function resolveMediaPathStrict(mediaRoot, relPath, { platform = process.platform } = {}) {
  if (!isSafeRelativePath(relPath, platform)) {
    return null;
  }
  try {
    const target = path.resolve(mediaRoot, relPath);
    const [realRoot, real] = await Promise.all([fs.realpath(mediaRoot), fs.realpath(target)]);
    return isContained(realRoot, real) ? real : null;
  } catch (err) {
    const code = /** @type {{ code?: unknown }} */ (err)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw err;
  }
}

/**
 * Up-front, filesystem-independent rejection of an unsafe relative path.
 *
 * @param {string} relPath
 * @param {string} platform - `'win32'` rejects any `:` in `relPath` (NTFS
 *   alternate-data-stream selector); other platforms allow a `:` inside a
 *   segment (e.g. a Linux file name such as `Title: Subtitle.mp4`).
 * @returns {boolean}
 */
function isSafeRelativePath(relPath, platform) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.includes('\0')) {
    return false;
  }
  if (relPath.startsWith('/') || relPath.startsWith('\\') || DRIVE_PREFIX_RE.test(relPath)) {
    return false;
  }
  if (platform === 'win32' && relPath.includes(':')) {
    return false;
  }
  return !relPath.split(/[/\\]/).includes('..');
}

/**
 * Whether the realpath'd `real` target lies inside the realpath'd `realRoot`.
 *
 * @param {string} realRoot
 * @param {string} real
 * @returns {boolean}
 */
function isContained(realRoot, real) {
  const rel = path.relative(realRoot, real);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
