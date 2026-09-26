// @ts-check

import { cleanName, normalizeSeparators, parseYear } from './text.js';

/**
 * @typedef {object} MovieResult
 * @property {string} title display title; empty only when nothing remains
 *   after `cleanName` (e.g. a name that is only a parenthesised year)
 * @property {number | null} year release year, or `null` when not determined
 */

/**
 * Strips the last extension from a filename.
 * @param {string} fileName the last path segment, with extension
 * @returns {string} the stem
 */
function stripExtension(fileName) {
  const idx = fileName.lastIndexOf('.');
  return idx > 0 ? fileName.slice(0, idx) : fileName;
}

/**
 * Finds the first `(YYYY)`/`[YYYY]` group that parses as a plausible year.
 * @param {string} s stem or folder name
 * @param {() => number} now injected clock
 * @returns {{ index: number, year: number } | null} match position and year
 */
function firstValidParenYear(s, now) {
  const re = /\((\d{4})\)|\[(\d{4})\]/g;
  let match = re.exec(s);
  while (match !== null) {
    const token = match[1] ?? match[2];
    const year = parseYear(token, now);
    if (year !== null) {
      return { index: match.index, year };
    }
    match = re.exec(s);
  }
  return null;
}

/**
 * Finds the last whitespace-separated year token that is not the first
 * token, so a title starting with a year-looking number is not misread.
 * @param {string} s stem or folder name
 * @param {() => number} now injected clock
 * @returns {MovieResult | null} title (tokens before the year) and the year
 */
function extractYearFromTokens(s, now) {
  const tokens = normalizeSeparators(s).split(/\s+/).filter(Boolean);
  let yearIndex = -1;
  let year = null;
  for (let i = 1; i < tokens.length; i++) {
    const candidate = parseYear(tokens[i], now);
    if (candidate !== null) {
      yearIndex = i;
      year = candidate;
    }
  }
  if (yearIndex === -1 || year === null) {
    return null;
  }
  return { title: cleanName(tokens.slice(0, yearIndex).join(' ')), year };
}

/**
 * Applies parse rules 1 and 2 (parenthesised year, then token year) to one
 * stem or folder name.
 * @param {string} s stem or folder name
 * @param {() => number} now injected clock
 * @returns {MovieResult | null} the result, or `null` when no year is found
 */
function extractTitleYear(s, now) {
  const parenMatch = firstValidParenYear(s, now);
  if (parenMatch) {
    return { title: cleanName(s.slice(0, parenMatch.index)), year: parenMatch.year };
  }
  return extractYearFromTokens(s, now);
}

/**
 * Applies movie parse rules 1–3 (parenthesised year, token year, else
 * `cleanName`) to a plain name with no extension to strip — used for a
 * folder name, such as a series' folder (rules 1–3 on the folder name).
 * @param {string} name raw folder (or extension-free) name
 * @param {() => number} now injected clock
 * @returns {MovieResult} the best-effort title and year
 */
export function titleYearFromName(name, now) {
  return extractTitleYear(name, now) ?? { title: cleanName(name), year: null };
}

/**
 * Parses a movie's title and year from its path relative to the category
 * folder (`Filme`/`Movies`), per the spec's movie parse rules 1–4.
 * @param {string} relInCategory `/`-separated path below the category folder
 * @param {() => number} now injected clock (epoch ms), for the year upper bound
 * @returns {MovieResult} the best-effort title and year
 */
export function parseMovie(relInCategory, now) {
  const segments = relInCategory.split('/');
  const stem = stripExtension(segments[segments.length - 1]);
  const fromStem = extractTitleYear(stem, now);
  if (fromStem) {
    return fromStem;
  }
  for (let i = segments.length - 2; i >= 0; i--) {
    const fromFolder = extractTitleYear(segments[i], now);
    if (fromFolder) {
      return fromFolder;
    }
  }
  return { title: cleanName(stem), year: null };
}
