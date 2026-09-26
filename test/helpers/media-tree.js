// @ts-check
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Shared temp-tree helper for `src/library/` tests: build a small on-disk
 * tree to point a fake `MEDIA_ROOT` at, then tear it down. Every path taken
 * or returned here is '/'-separated, matching `rel_path`'s on-disk form;
 * callers join it onto an absolute root themselves via `path.join`, which
 * accepts '/' segments on every supported platform.
 */

/**
 * Creates a fresh, empty temp directory to use as a fake `MEDIA_ROOT`.
 * @param {string} [prefix]
 * @returns {Promise<string>} absolute path to the new directory
 */
export async function createMediaTree(prefix = 'vt-media-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Recursively removes a tree created by `createMediaTree`.
 * @param {string} root absolute path returned by `createMediaTree`
 * @returns {Promise<void>}
 */
export async function removeMediaTree(root) {
  await fs.rm(root, { recursive: true, force: true });
}

/**
 * Creates a directory (and any missing parents) inside `root`.
 * @param {string} root absolute path
 * @param {string} relDir '/'-separated path relative to `root`
 * @returns {Promise<string>} the absolute path of the created directory
 */
export async function makeMediaDir(root, relDir) {
  const absDir = path.join(root, ...relDir.split('/'));
  await fs.mkdir(absDir, { recursive: true });
  return absDir;
}

/**
 * Writes a file inside `root`, creating parent directories as needed.
 * @param {string} root absolute path
 * @param {string} relPath '/'-separated path relative to `root`
 * @param {object} [options]
 * @param {string | Buffer} [options.content] file content (default: a few bytes)
 * @param {Date | number} [options.mtime] mtime to set after writing (epoch ms, or a `Date`)
 * @returns {Promise<string>} the absolute path of the written file
 */
export async function writeMediaFile(root, relPath, { content = 'x', mtime } = {}) {
  const segments = relPath.split('/');
  const absPath = path.join(root, ...segments);
  if (segments.length > 1) {
    await fs.mkdir(path.join(root, ...segments.slice(0, -1)), { recursive: true });
  }
  await fs.writeFile(absPath, content);
  if (mtime !== undefined) {
    const time = mtime instanceof Date ? mtime : new Date(mtime);
    await fs.utimes(absPath, time, time);
  }
  return absPath;
}
