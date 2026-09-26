/**
 * Pure, DOM-free formatting helpers for the image gallery frontend
 * (`/images`). No DOM access, no imports from `src/` — see
 * docs/specs/spec-image-gallery.md, unit-tested from `test/public/`.
 */

/**
 * Formats a server-supplied local date-time string as `DD.MM.YYYY, HH:MM` by
 * string slicing (never `Date` parsing, so no timezone drift between server
 * and client).
 * @param {string | null | undefined} s - Local date-time in
 *   `YYYY-MM-DDTHH:MM:SS` form (the API's `takenAt` field).
 * @returns {string} The formatted date, or `''` when `s` is not a usable
 *   string.
 */
export function formatTakenAt(s) {
  if (typeof s !== 'string' || s.length < 16) return '';
  const year = s.slice(0, 4);
  const month = s.slice(5, 7);
  const day = s.slice(8, 10);
  const hour = s.slice(11, 13);
  const minute = s.slice(14, 16);
  return `${day}.${month}.${year}, ${hour}:${minute}`;
}

/**
 * Maps an EXIF orientation value to the CSS class that applies its upright
 * transform (Decision log: `orient-2`..`orient-8` map to `scaleX(-1)`,
 * `rotate(180deg)`, `scaleY(-1)`, `rotate(270deg) scaleX(-1)`,
 * `rotate(90deg)`, `rotate(90deg) scaleX(-1)`, `rotate(270deg)`
 * respectively). Orientation 1 (normal) and any unknown value need no
 * transform.
 * @param {number} n - EXIF orientation (1-8 expected).
 * @returns {string} `'orient-2'`..`'orient-8'`, or `''` for 1 / unknown.
 */
export function orientationClass(n) {
  return Number.isInteger(n) && n >= 2 && n <= 8 ? `orient-${n}` : '';
}

/**
 * Formats a file count as the German singular/plural label.
 * @param {number} n - File count.
 * @returns {string} `'1 Datei'` for exactly 1, `'{n} Dateien'` otherwise.
 */
export function countLabel(n) {
  return n === 1 ? '1 Datei' : `${n} Dateien`;
}

/**
 * Builds the folder header meta line from the non-zero of its two parts.
 * @param {number} folders - Direct subfolder count.
 * @param {number} items - Direct item count.
 * @returns {string} `'{n} Ordner'` and/or `countLabel(items)`, joined by
 *   `' · '`; `''` when both counts are 0.
 */
export function headerMeta(folders, items) {
  const parts = [];
  if (folders !== 0) parts.push(`${folders} Ordner`);
  if (items !== 0) parts.push(countLabel(items));
  return parts.join(' · ');
}

/**
 * Parses a `#bild-<id>` location hash into the positive safe-integer item id
 * it names.
 * @param {string} hash - `location.hash` value.
 * @returns {number | null} The id, or `null` when `hash` does not match
 *   exactly `#bild-` followed by a positive integer with no leading zero.
 */
export function parseBildHash(hash) {
  if (typeof hash !== 'string') return null;
  const match = /^#bild-([1-9]\d{0,15})$/.exec(hash);
  return match ? Number(match[1]) : null;
}
