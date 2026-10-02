// @ts-check

/**
 * Pure target mapping for on-demand conversion
 * (`docs/specs/archive/spec-conversion-core.md` "Targets"). No I/O: decides only
 * whether and how a library item could be converted, and derives the
 * directory name its copy would be stored under.
 */

import { createHash } from 'node:crypto';

/** @typedef {import('../library/categories.js').Category} Category */
/** @typedef {import('../library/categories.js').Kind} Kind */
/** @typedef {import('../db/library-repo.js').LibraryItemRow} LibraryItemRow */

/** @typedef {'web' | 'flac' | 'opus'} ConversionTarget */

/**
 * @typedef {object} TargetInput
 * @property {Category} category
 * @property {Kind} kind
 * @property {string} ext lower-case extension without the dot
 */

/** Lossless-capable music extensions that convert to `flac` instead of `opus`. */
const LOSSLESS_MUSIC_EXTS = new Set(['ape', 'aif', 'aiff', 'wv', 'dsf', 'dff', 'm4a', 'm4b']);

/**
 * Fixed output shape per conversion target: the file name the queue publishes
 * under `CONVERT_DIR/<storage_key>/`, its extension and the resulting kind.
 * @type {Readonly<Record<ConversionTarget, Readonly<{ file: string, ext: string, kind: Kind }>>>}
 */
export const TARGETS = Object.freeze({
  web: Object.freeze({ file: 'web.mp4', ext: 'mp4', kind: 'video' }),
  flac: Object.freeze({ file: 'audio.flac', ext: 'flac', kind: 'audio' }),
  opus: Object.freeze({ file: 'audio.opus', ext: 'opus', kind: 'audio' }),
});

/**
 * Maps a library item's shape to the conversion target it would produce, or
 * `null` when it is not convertible at all. Rows are checked top to bottom
 * and the first match wins, so the `null` row for MIDI/images comes before
 * `audiobooks` -> `opus` (spec-conversion-core.md "Targets" table).
 * @param {TargetInput} input
 * @returns {ConversionTarget | null}
 */
export function targetFor({ category, kind, ext }) {
  if (ext === 'mid' || ext === 'midi' || kind === 'image' || category === 'images') return null;
  if (kind === 'video' && (category === 'movies' || category === 'series')) return 'web';
  if (category === 'audiobooks') return 'opus';
  if (category === 'music') return LOSSLESS_MUSIC_EXTS.has(ext) ? 'flac' : 'opus';
  return null;
}

/**
 * Whether a library item could be queued for conversion right now: not
 * already playable, has bytes, and maps to a target. `row.playable` is typed
 * `boolean` (SQLite itself returns `0`/`1`), so only a truthiness test
 * type-checks and works for both.
 * @param {LibraryItemRow} row
 * @returns {boolean}
 */
export function isConvertible(row) {
  return !row.playable && row.size > 0 && targetFor(row) !== null;
}

/**
 * Derives the directory name a conversion's copy is stored under:
 * `sha256(rel_path)` lower-case hex, exactly as given with no Unicode
 * normalisation, so NFC and NFD spellings of the same visual path hash
 * differently (the DB's `storage_key` column, migration `006-conversions.sql`).
 * @param {string} relPath
 * @returns {string} 64 lower-case hex characters
 */
export function storageKey(relPath) {
  return createHash('sha256').update(relPath).digest('hex');
}
