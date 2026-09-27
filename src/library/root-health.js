// @ts-check
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { isSkippedName } from './walk.js';
import { categoryForFolder } from './categories.js';

/**
 * Category-root discovery and health for root safety (D7). Shared by
 * `scanner.js` (full scan) and `reconcile.js` (the ENOENT escalation check)
 * so both apply the exact same definition of an "empty" root: no entry left
 * after the skip rules (hidden/system names, symlinks, U+FFFD names) — a
 * root holding only e.g. an `.nfo` file is not empty.
 *
 * Spec: docs/specs/spec-library-video.md, "Scanner modules" (root safety).
 */

/**
 * @param {import('node:fs').Dirent} entry
 * @returns {boolean} whether the classification skip rules drop `entry`
 */
function isSkippedEntry(entry) {
  return entry.isSymbolicLink() || entry.name.includes('�') || isSkippedName(entry.name);
}

/**
 * Lists the category-root directories currently at the top of `mediaRoot`.
 * `readdir` failures propagate (the caller aborts the full scan).
 * @param {string} mediaRoot
 * @returns {Promise<Set<string>>} exact on-disk names
 */
export async function discoverRoots(mediaRoot) {
  const entries = await readdir(mediaRoot, { withFileTypes: true });
  const names = new Set();
  for (const entry of entries) {
    if (isSkippedEntry(entry) || !entry.isDirectory()) continue;
    if (categoryForFolder(entry.name)) names.add(entry.name);
  }
  return names;
}

/**
 * @param {string} mediaRoot
 * @param {string} rootName exact on-disk name of a category root
 * @returns {Promise<'missing' | 'unreadable' | 'empty' | null>} `null` = healthy
 */
export async function rootHealth(mediaRoot, rootName) {
  let entries;
  try {
    entries = await readdir(join(mediaRoot, rootName), { withFileTypes: true });
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err)?.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  return entries.some((entry) => !isSkippedEntry(entry)) ? null : 'empty';
}
