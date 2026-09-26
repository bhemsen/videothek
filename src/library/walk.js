// @ts-check
import { readdir, stat as fsStat } from 'node:fs/promises';
import { join } from 'node:path';
import { EXTENSIONS } from './parsers/compat.js';

/**
 * One directory's worth of I/O for the scanner: `readdir({ withFileTypes:
 * true })` plus one `stat` per candidate file (extension known), with the
 * skip rules (hidden names, known NAS/OS system folders, symlinks,
 * undecodable names, unknown extension) applied so a caller never sees a
 * skipped entry in `files` or `dirs`.
 *
 * Spec: docs/specs/spec-library-video.md, "Classification" (skip rules) and
 * "Scanner modules" (`walk.js`).
 */

/** @typedef {import('node:fs').Stats} Stats */
/** @typedef {(absPath: string) => Promise<Stats>} StatFn */

/**
 * @typedef {object} WalkFile
 * @property {string} name the entry's on-disk name (exact, not normalised)
 * @property {Stats} [stat] present when `stat` succeeded
 * @property {unknown} [error] present when `stat` failed with anything other
 *   than `ENOENT` (which drops the entry silently instead)
 */

/**
 * @typedef {object} WalkResult
 * @property {WalkFile[]} files candidate files, in `readdir` order
 * @property {string[]} dirs subdirectory names, in `readdir` order
 * @property {{ symlinks: number, undecodable: number }} skipped counts of
 *   entries skipped for being a symlink or for having a U+FFFD
 *   (undecodable) name; hidden names and known system folders are skipped
 *   silently and are not counted here
 */

/** Known NAS/OS folders that are never media, lower-cased for comparison. */
const SKIPPED_NAMES = new Set([
  '@eadir',
  '#recycle',
  '#snapshot',
  '$recycle.bin',
  'system volume information',
  'lost+found',
]);

/**
 * Whether a name is hidden (leading `.`) or one of the known NAS/OS system
 * folders (case-insensitive) that are never indexed, descended into, or
 * watched. Symlinks and undecodable (U+FFFD-containing) names are detected
 * separately by `listDirectory`, since those two need per-run counters
 * rather than a plain yes/no.
 * @param {string} name an entry's on-disk name
 * @returns {boolean}
 */
export function isSkippedName(name) {
  if (name.startsWith('.')) return true;
  return SKIPPED_NAMES.has(name.toLowerCase());
}

/**
 * @param {string} name
 * @returns {boolean} whether `name` contains the Unicode replacement
 *   character (undecodable bytes from the filesystem — cannot be reopened
 *   reliably by exact name)
 */
function isUndecodable(name) {
  return name.includes('�');
}

/**
 * @param {string} name a file's on-disk name
 * @returns {boolean} whether `name`'s lower-cased extension is a known key of
 *   `EXTENSIONS` — `item-builder.js` can never admit any other extension, so
 *   `stat`-ing such a file is wasted I/O on every rescan (spec: "Scanner
 *   modules", `walk.js`)
 */
function hasKnownExtension(name) {
  const idx = name.lastIndexOf('.');
  if (idx <= 0) return false;
  const ext = name.slice(idx + 1).toLowerCase();
  return Object.hasOwn(EXTENSIONS, ext);
}

/**
 * Lists one directory's admissible entries. A `stat` failing with `ENOENT`
 * (the file vanished between `readdir` and `stat`) drops the file silently;
 * any other `stat` error is reported in `files` as `{ name, error }` so the
 * caller can decide what to do (e.g. keep the file's existing index row).
 * `readdir` failures are not caught here — handling an unreadable directory
 * is the caller's (scanner's) responsibility.
 * @param {string} absDir absolute path of the directory to list
 * @param {{ statFn?: StatFn }} [deps] `statFn` is injectable for tests;
 *   defaults to `fs.stat`
 * @returns {Promise<WalkResult>}
 */
export async function listDirectory(absDir, { statFn = fsStat } = {}) {
  const entries = await readdir(absDir, { withFileTypes: true });
  /** @type {WalkFile[]} */
  const files = [];
  /** @type {string[]} */
  const dirs = [];
  let symlinks = 0;
  let undecodable = 0;

  for (const entry of entries) {
    const name = entry.name;
    if (entry.isSymbolicLink()) {
      symlinks += 1;
      continue;
    }
    if (isUndecodable(name)) {
      undecodable += 1;
      continue;
    }
    if (isSkippedName(name)) {
      continue;
    }
    if (entry.isDirectory()) {
      dirs.push(name);
      continue;
    }
    if (!entry.isFile()) {
      continue; // socket, FIFO, device, or another non-media entry type
    }
    if (!hasKnownExtension(name)) {
      continue; // .nfo/.srt/.vtt/.txt/no-extension etc. - never indexable
    }
    try {
      const stat = await statFn(join(absDir, name));
      files.push({ name, stat });
    } catch (err) {
      if (/** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') {
        continue;
      }
      files.push({ name, error: err });
    }
  }

  return { files, dirs, skipped: { symlinks, undecodable } };
}
