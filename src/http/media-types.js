// @ts-check

import { mimeForExtension } from '../library/parsers/compat.js';

/** MIME type returned for an unknown or non-playable extension. */
const FALLBACK_MIME = 'application/octet-stream';

/**
 * Looks up the HTTP `Content-Type` to serve for a file extension. A thin,
 * lower-cased lookup over P2's single compatibility table
 * (`src/library/parsers/compat.js`, D9) — this module holds no MIME table of
 * its own, so a new extension is added in exactly one place.
 *
 * Accepts the extension with or without a leading dot so that callers can
 * pass either a bare extension (e.g. `'mp4'`) or the raw result of
 * `path.extname()` (e.g. `'.mp4'`) directly.
 *
 * @param {string} ext - a file extension, with or without a leading dot, in
 *   any case (e.g. `'MP4'`, `'.mp4'`, `'mp4'`).
 * @returns {string} the MIME type from the compat table, or
 *   `'application/octet-stream'` when the extension is unknown or not
 *   playable (no `mime` recorded for it).
 */
export function mediaTypeFor(ext) {
  const normalized = ext.toLowerCase().replace(/^\./, '');
  return mimeForExtension(normalized) ?? FALLBACK_MIME;
}
