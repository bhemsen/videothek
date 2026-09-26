// @ts-check

/**
 * @typedef {object} EpisodeCodeInput
 * @property {number | null | undefined} season season number, or `null`/`undefined` when unknown
 * @property {number | null | undefined} episode episode number, or `null`/`undefined` when unknown
 * @property {number | null | undefined} episodeEnd end episode of a multi-episode file, if any
 */

const RELEASE_TOKENS = [
  '\\d{3,4}p',
  '4k',
  'uhd',
  'hdr',
  'hdr10',
  'bluray',
  'blu-ray',
  'bdrip',
  'brrip',
  'web-dl',
  'webdl',
  'webrip',
  'hdtv',
  'dvdrip',
  'remux',
  'x264',
  'x265',
  'h264',
  'h265',
  'hevc',
  'xvid',
  'divx',
  'av1',
  'aac',
  'ac3',
  'dts',
  'truehd',
  'atmos',
  'german',
  'deutsch',
  'english',
  'multi',
  'dl',
  'proper',
  'repack'
];

const RELEASE_TOKEN_RE = new RegExp(`\\b(?:${RELEASE_TOKENS.join('|')})\\b`, 'i');

/**
 * Normalises separators the way `cleanName` does, without the rest of its
 * pipeline: used by parsers that need to tokenise a stem or folder name
 * before applying their own rules.
 * @param {string} s raw stem or folder name
 * @returns {string} `s` with `.`/`_` (or just `_`) replaced by spaces
 */
export function normalizeSeparators(s) {
  return s.includes(' ') ? s.replace(/_/g, ' ') : s.replace(/[._]/g, ' ');
}

/**
 * Normalises a raw filename stem or folder name into a display title.
 * @param {string} s raw stem or folder name
 * @returns {string} the cleaned title; empty only when `s` itself is empty
 */
export function cleanName(s) {
  let result = normalizeSeparators(s);
  result = result.replace(/\[[^\]]*\]/g, ' ');
  const match = result.match(RELEASE_TOKEN_RE);
  if (match && typeof match.index === 'number') {
    result = result.slice(0, match.index);
  }
  result = result.replace(/\s+/g, ' ').trim();
  result = result.replace(/[ \-._]+$/, '');
  if (result === '') {
    result = s.replace(/[._]/g, ' ').trim();
  }
  if (result === '') {
    result = s;
  }
  return result;
}

/**
 * Builds a natural-sort key: accent-insensitive, case-insensitive, digit
 * runs left-padded so "Teil 2" sorts before "Teil 10".
 * @param {string} title display title
 * @returns {string} the sort key
 */
export function sortKey(title) {
  const withoutMarks = title.normalize('NFKD').replace(/\p{Mn}/gu, '');
  const lower = withoutMarks.toLowerCase();
  return lower.replace(/\d+/g, (run) => run.padStart(8, '0'));
}

/**
 * Parses a 4-digit year token, rejecting out-of-range values.
 * @param {string} token candidate token
 * @param {() => number} now injected clock (epoch ms)
 * @returns {number | null} the year, or `null` when `token` is not a plausible year
 */
export function parseYear(token, now) {
  if (!/^\d{4}$/.test(token)) {
    return null;
  }
  const year = Number(token);
  const maxYear = new Date(now()).getUTCFullYear() + 1;
  if (year < 1888 || year > maxYear) {
    return null;
  }
  return year;
}

/**
 * Formats the language-neutral episode code shown as a title fallback.
 * @param {EpisodeCodeInput} input season/episode/episodeEnd, any of which may be unknown
 * @returns {string | null} e.g. `"S01E06"`, `"S01E01-E02"`, `"E06"`, or `null` when the episode is unknown
 */
export function episodeCode({ season, episode, episodeEnd }) {
  if (episode === null || episode === undefined) {
    return null;
  }
  const ep = String(episode).padStart(2, '0');
  const end =
    episodeEnd === null || episodeEnd === undefined ? null : String(episodeEnd).padStart(2, '0');
  if (season === null || season === undefined) {
    return end ? `E${ep}-E${end}` : `E${ep}`;
  }
  const se = String(season).padStart(2, '0');
  return end ? `S${se}E${ep}-E${end}` : `S${se}E${ep}`;
}
