import fs from 'node:fs/promises';
import path from 'node:path';

const DRIVE_PREFIX_RE = /^[a-zA-Z]:/;

/**
 * Resolves a client-supplied path relative to `mediaRoot` and verifies it
 * stays inside it, per the constitution's path-containment rule.
 *
 * Rejects up front any `relPath` that is empty, contains a NUL byte, is
 * absolute in POSIX or Windows form (including a UNC path or a Windows
 * drive-relative path such as `C:foo`), or has any `..` segment. The
 * remaining candidate is resolved against `mediaRoot` and both are
 * `realpath`d, so a symlink or junction that escapes the root — or one whose
 * target simply does not exist — is rejected too. Stateless: `mediaRoot` is
 * re-resolved on every call instead of being cached.
 *
 * @param {string} mediaRoot - Absolute path to the media root directory.
 * @param {string} relPath - Client-supplied path, relative to `mediaRoot`.
 * @returns {Promise<string | null>} The resolved absolute path inside
 *   `mediaRoot`, or `null` when `relPath` is unsafe, escapes the root, or
 *   cannot be resolved (missing file, permission error, etc.).
 */
export async function resolveMediaPath(mediaRoot, relPath) {
  if (!isSafeRelativePath(relPath)) {
    return null;
  }

  try {
    const realRoot = await fs.realpath(mediaRoot);
    const target = path.resolve(mediaRoot, relPath);
    const real = await fs.realpath(target);
    return isContained(realRoot, real) ? real : null;
  } catch {
    return null;
  }
}

/**
 * Up-front, filesystem-independent rejection of an unsafe relative path.
 *
 * @param {string} relPath
 * @returns {boolean}
 */
function isSafeRelativePath(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0 || relPath.includes('\0')) {
    return false;
  }
  if (relPath.startsWith('/') || relPath.startsWith('\\') || DRIVE_PREFIX_RE.test(relPath)) {
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
