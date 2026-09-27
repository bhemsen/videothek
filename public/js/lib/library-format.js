/**
 * Pure, DOM-free formatting helpers for the library video UI (`/movies`,
 * `/series`, `/series-detail`). No DOM access, no imports — see
 * docs/specs/spec-library-video.md "UI", unit-tested from `test/public/`.
 *
 * `episodeCode` mirrors the server's rule in
 * `src/library/parsers/text.js` exactly (spec Decision log): the frontend
 * keeps its own copy because it never imports server modules.
 */

const EN_DASH = '–';
const UNPLAYABLE_TITLE = 'Dieses Dateiformat kann der Browser nicht direkt abspielen.';

/**
 * Zero-pads a number to at least 2 digits.
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Builds up to two initials from a title: the first letter or digit of each
 * of its first two words, upper-cased.
 * @param {string} title
 * @returns {string} At most two characters, or `'#'` when the title has no
 *   letter or digit in its first two words (or is empty/not a string).
 */
export function initials(title) {
  if (typeof title !== 'string') return '#';
  const words = title.split(/\s+/).filter(Boolean).slice(0, 2);
  const chars = [];
  for (const word of words) {
    const match = /\p{L}|\p{N}/u.exec(word);
    if (match) chars.push(match[0].toUpperCase());
  }
  return chars.length > 0 ? chars.join('') : '#';
}

/**
 * Formats a count with the German singular or plural word.
 * @param {number} n
 * @param {string} singular - Used when `n === 1`.
 * @param {string} plural - Used otherwise (incl. `n === 0`).
 * @returns {string} `'{n} {word}'`.
 */
export function pluralize(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** File-size units, smallest to largest; GB is the largest (no TB). */
const FILE_SIZE_UNITS = ['B', 'KB', 'MB', 'GB'];

const fileSizeFormatter = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/**
 * Formats a byte count 1024-based with B/KB/MB/GB units.
 * @param {number} bytes
 * @returns {string} Integer bytes below 1024 (`'512 B'`), else one decimal
 *   in the largest unit that keeps the value under 1024, de-DE formatted
 *   (`'1,4 GB'`); GB is never exceeded.
 */
export function formatFileSize(bytes) {
  if (bytes < 1024) return `${Math.trunc(bytes)} B`;
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < FILE_SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${fileSizeFormatter.format(value)} ${FILE_SIZE_UNITS[unitIndex]}`;
}

/**
 * @typedef {object} EpisodeIdentity
 * @property {number | null} [season] - `0` for specials, `null`/absent when unknown.
 * @property {number | null} episode - `null` when unknown.
 * @property {number | null} [episodeEnd] - End of a multi-episode range.
 */

/**
 * Formats the episode-row number column.
 * @param {EpisodeIdentity} identity
 * @returns {string} `'01'`, a range `'01–02'`, or `'–'` when the
 *   episode is unknown; always at least 2 digits.
 */
export function episodeNumber({ episode, episodeEnd }) {
  if (episode == null) return EN_DASH;
  return episodeEnd != null ? `${pad2(episode)}${EN_DASH}${pad2(episodeEnd)}` : pad2(episode);
}

/**
 * Builds the language-neutral episode identifier the server also computes
 * (`src/library/parsers/text.js`), used to detect a fallback title.
 * @param {EpisodeIdentity} identity
 * @returns {string | null} `'S01E06'` / `'S01E01-E02'` (season and episode
 *   at least 2 digits), `'E06'` / `'E06-E07'` when the season is unknown,
 *   `null` when the episode is unknown.
 */
export function episodeCode({ season, episode, episodeEnd }) {
  if (episode == null) return null;
  const seasonPrefix = season != null ? `S${pad2(season)}` : '';
  const range = episodeEnd != null ? `E${pad2(episode)}-E${pad2(episodeEnd)}` : `E${pad2(episode)}`;
  return `${seasonPrefix}${range}`;
}

/**
 * @typedef {EpisodeIdentity & { title: string }} EpisodeTitleInput
 */

/**
 * Resolves the label shown for an episode row: the parsed title, or a
 * German "Folge N" / "Folgen 1–2" fallback when the title is exactly
 * the language-neutral episode code (the server never invents German text).
 * @param {EpisodeTitleInput} input
 * @returns {string}
 */
export function episodeLabel({ title, season, episode, episodeEnd }) {
  const code = episodeCode({ season, episode, episodeEnd });
  if (code === null || title !== code) return title;
  return episodeEnd != null ? `Folgen ${episode}${EN_DASH}${episodeEnd}` : `Folge ${episode}`;
}

export { UNPLAYABLE_TITLE };
