// @ts-check

/**
 * Cover art lookup for one music/audiobooks item: folder image, else a
 * sidecar image, else the item's own embedded tag picture. Pure filesystem
 * lookup — the caller (`src/api/cover.js`) turns the result into an HTTP
 * response via `src/http/stream.js`'s `sendMedia`; nothing is cached here.
 *
 * @see docs/specs/spec-music-audiobooks.md — "Cover lookup" decision.
 */

import { readdir } from 'node:fs/promises';
import path from 'node:path';

/** Folder/sidecar base names, in priority order (case-insensitive; sidecar lookup uses a single name, the file's own stem). */
const FOLDER_NAMES = ['cover', 'folder', 'front'];

/** Image extensions, in priority order (case-insensitive), for both folder and sidecar images. */
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp'];

/**
 * @typedef {object} CoverRow - the fields `findCover` needs off a joined audio row.
 * @property {string} relPath - the item's own file, relative to `mediaRoot`.
 * @property {string} dir - the item's own containing directory.
 * @property {string} ext - lower-case extension without the dot.
 * @property {string} groupKey - the album/book's directory `rel_path`, or —
 *   for a single-file audiobook only — the file's own `relPath`.
 * @property {string | null} groupTitle - `null` for a pseudo-album (music
 *   only); set for a real album/book directory and, uniquely, also for a
 *   single-file book (distinguished from a real directory by `groupKey`).
 */

/**
 * @typedef {{ kind: 'file', path: string } |
 *   { kind: 'slice', path: string, offset: number, length: number, mime: string }} CoverResult
 */

/** @typedef {{ offset: number, length: number, mime: string }} PictureRef */

/**
 * Finds the on-disk cover for one music/audiobooks item, trying in order:
 * (1) a folder image — for a real album/book directory (depth >= 2): the
 * item's own `dir` first when it is a disc subfolder of `groupKey`, then
 * `groupKey` itself; for a pseudo-album or single-file book instead a
 * sidecar image sharing the file's stem, in the item's own `dir`.
 * (2) the item's own embedded picture (`readPicture`). (3) `null`.
 *
 * @param {object} params
 * @param {string} params.mediaRoot
 * @param {CoverRow} params.row
 * @param {(mediaRoot: string, relPath: string) => Promise<string | null>} params.resolvePath
 *   `resolveMediaPath` (or a test stub) — every directory is resolved before
 *   `readdir`, and the chosen file is resolved again before use.
 * @param {(absPath: string, info: { ext: string }) => Promise<PictureRef | null>} params.readPicture
 *   `readPictureRef` (or a test stub).
 * @returns {Promise<CoverResult | null>}
 */
export async function findCover({ mediaRoot, row, resolvePath, readPicture }) {
  const isRealGroupDir = row.groupKey !== row.relPath && row.groupTitle !== null;
  const folderResult = isRealGroupDir
    ? await findRealGroupCover(mediaRoot, row, resolvePath)
    : await findSidecarCover(mediaRoot, row, resolvePath);
  if (folderResult) return folderResult;

  const itemPath = await resolvePath(mediaRoot, row.relPath);
  if (itemPath === null) return null;
  const picture = await readPicture(itemPath, { ext: row.ext });
  if (!picture) return null;
  return { kind: 'slice', path: itemPath, offset: picture.offset, length: picture.length, mime: picture.mime };
}

/**
 * Real album/book directory: the item's own `dir` first when it differs from
 * `groupKey` (a disc subfolder), then the group directory itself.
 * @param {string} mediaRoot @param {CoverRow} row
 * @param {(mediaRoot: string, relPath: string) => Promise<string | null>} resolvePath
 * @returns {Promise<{ kind: 'file', path: string } | null>}
 */
async function findRealGroupCover(mediaRoot, row, resolvePath) {
  const dirsToTry = row.dir !== row.groupKey ? [row.dir, row.groupKey] : [row.groupKey];
  for (const dir of dirsToTry) {
    const found = await findNamedImage(mediaRoot, dir, FOLDER_NAMES, resolvePath);
    if (found) return found;
  }
  return null;
}

/**
 * Pseudo-album / single-file book: a sidecar image sharing the file's stem,
 * in the item's own directory.
 * @param {string} mediaRoot @param {CoverRow} row
 * @param {(mediaRoot: string, relPath: string) => Promise<string | null>} resolvePath
 * @returns {Promise<{ kind: 'file', path: string } | null>}
 */
function findSidecarCover(mediaRoot, row, resolvePath) {
  const stem = path.posix.basename(row.relPath, path.posix.extname(row.relPath));
  return findNamedImage(mediaRoot, row.dir, [stem], resolvePath);
}

/**
 * Resolves `dirRelPath` inside `mediaRoot`, lists it (regular files only —
 * symlinks are skipped by `Dirent#isFile()`) and returns the first match for
 * one of `baseNames` (tried in order) in {@link IMAGE_EXTS} priority order,
 * itself re-resolved before being returned. `null` on any resolve/list miss.
 * @param {string} mediaRoot @param {string} dirRelPath
 * @param {string[]} baseNames
 * @param {(mediaRoot: string, relPath: string) => Promise<string | null>} resolvePath
 * @returns {Promise<{ kind: 'file', path: string } | null>}
 */
async function findNamedImage(mediaRoot, dirRelPath, baseNames, resolvePath) {
  const absDir = await resolvePath(mediaRoot, dirRelPath);
  if (absDir === null) return null;

  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const filesByLowerName = new Map(entries.filter((e) => e.isFile()).map((e) => [e.name.toLowerCase(), e.name]));

  for (const base of baseNames) {
    for (const ext of IMAGE_EXTS) {
      const onDisk = filesByLowerName.get(`${base.toLowerCase()}.${ext}`);
      if (onDisk === undefined) continue;
      const resolved = await resolvePath(mediaRoot, `${dirRelPath}/${onDisk}`);
      if (resolved !== null) return { kind: 'file', path: resolved };
    }
  }
  return null;
}
