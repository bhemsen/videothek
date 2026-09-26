// @ts-check

import { cleanName, episodeCode } from './text.js';
import { titleYearFromName } from './movie.js';

/**
 * @typedef {object} EpisodeResult
 * @property {string} seriesKey exact series folder name, or the cleaned title of a loose file
 * @property {string} seriesTitle display title of the series
 * @property {number | null} seriesYear release year of the series, or `null`
 * @property {number | null} season season number, `0` for specials, `null` when unknown
 * @property {number | null} episode episode number, or `null` when unknown
 * @property {number | null} episodeEnd end episode of a multi-episode file, or `null`
 * @property {string} title episode display title, never empty
 */

/** @typedef {{ season: number | null, episode: number | null, episodeEnd: number | null, matchStart: number | null, matchEnd: number | null }} SeasonEpisodeMatch */

const SXXEXX_RE = /\bS(\d{1,2})[ ._-]?E(\d{1,3})(?:(?:-?E|-)(\d{1,3})\b)?/i;
const NXMM_RE = /\b(\d{1,2})x(\d{2,3})\b/i;
const SEASON_FOLDER_RE = /^(?:season|staffel|s)[ ._-]*(\d{1,2})$/i;
const SPECIALS_FOLDER_RE = /^specials?$/i;
const EPISODE_WORD_RE = /\b(?:e|ep|episode|folge|teil)[ ._-]*(\d{1,3})\b/i;
const LEADING_NUMBER_RE = /^(\d{1,3})[ ._-]/;

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
 * Finds the season implied by the nearest matching ancestor folder below the
 * series folder (`Staffel N`/`Season N`/`S N`, or `Specials` → `0`).
 * @param {string[]} ancestorFolders folders between the series folder and the file, nearest last
 * @returns {number | null} the season, or `null` when no folder matches
 */
function seasonFromFolders(ancestorFolders) {
  for (let i = ancestorFolders.length - 1; i >= 0; i--) {
    const folder = ancestorFolders[i];
    if (SPECIALS_FOLDER_RE.test(folder)) {
      return 0;
    }
    const match = SEASON_FOLDER_RE.exec(folder);
    if (match) {
      return Number(match[1]);
    }
  }
  return null;
}

/**
 * Detects season/episode on the file stem, first match wins (rules 1–4).
 * @param {string} stem filename without extension
 * @param {string[]} ancestorFolders folders between the series folder and the file
 * @returns {SeasonEpisodeMatch} the match, with `matchStart`/`matchEnd` delimiting the
 *   token consumed on `stem` (`null` when nothing in `stem` was matched)
 */
function detectSeasonEpisode(stem, ancestorFolders) {
  const sxxexx = SXXEXX_RE.exec(stem);
  if (sxxexx) {
    return {
      season: Number(sxxexx[1]),
      episode: Number(sxxexx[2]),
      episodeEnd: sxxexx[3] !== undefined ? Number(sxxexx[3]) : null,
      matchStart: sxxexx.index,
      matchEnd: sxxexx.index + sxxexx[0].length
    };
  }
  const nxmm = NXMM_RE.exec(stem);
  if (nxmm) {
    return {
      season: Number(nxmm[1]),
      episode: Number(nxmm[2]),
      episodeEnd: null,
      matchStart: nxmm.index,
      matchEnd: nxmm.index + nxmm[0].length
    };
  }
  return detectFromFolderAndStem(stem, ancestorFolders);
}

/**
 * Rules 3–4: season from the nearest matching ancestor folder, combined with
 * an episode word or a leading number in the stem.
 * @param {string} stem filename without extension
 * @param {string[]} ancestorFolders folders between the series folder and the file
 * @returns {SeasonEpisodeMatch} the match (rule 4 when no episode token is found)
 */
function detectFromFolderAndStem(stem, ancestorFolders) {
  const folderSeason = seasonFromFolders(ancestorFolders);
  const episodeWord = EPISODE_WORD_RE.exec(stem);
  if (episodeWord) {
    return {
      season: folderSeason,
      episode: Number(episodeWord[1]),
      episodeEnd: null,
      matchStart: episodeWord.index,
      matchEnd: episodeWord.index + episodeWord[0].length
    };
  }
  const leading = LEADING_NUMBER_RE.exec(stem);
  if (leading) {
    return {
      season: folderSeason,
      episode: Number(leading[1]),
      episodeEnd: null,
      matchStart: leading.index,
      matchEnd: leading.index + leading[0].length
    };
  }
  return { season: folderSeason, episode: null, episodeEnd: null, matchStart: null, matchEnd: null };
}

/**
 * Derives the series key/title/year: the exact subfolder name (parsed with
 * movie rules 1–3 on the folder name itself, not as a file stem — the folder
 * has no extension to strip), or, for a loose file, the cleaned text before
 * the matched season/episode token.
 * @param {string[]} segments the full `/`-split relative path
 * @param {string} stem the file stem
 * @param {SeasonEpisodeMatch} match the detected season/episode match
 * @param {() => number} now injected clock
 * @returns {{ seriesKey: string, seriesTitle: string, seriesYear: number | null }} series identity
 */
function deriveSeries(segments, stem, match, now) {
  if (segments.length > 1) {
    const folder = segments[0];
    const parsed = titleYearFromName(folder, now);
    return { seriesKey: folder, seriesTitle: parsed.title, seriesYear: parsed.year };
  }
  const before = match.matchStart !== null ? stem.slice(0, match.matchStart) : stem;
  const title = cleanName(before);
  return { seriesKey: title, seriesTitle: title, seriesYear: null };
}

/**
 * Derives the episode display title from the text after the matched token,
 * falling back to the episode code, then the whole stem.
 * @param {string} stem the file stem
 * @param {SeasonEpisodeMatch} match the detected season/episode match
 * @returns {string} the episode title, never empty
 */
function deriveEpisodeTitle(stem, match) {
  const after = match.matchEnd !== null ? stem.slice(match.matchEnd) : '';
  const title = cleanName(after.replace(/^[ ._-]+/, ''));
  if (title !== '') {
    return title;
  }
  const code = episodeCode({ season: match.season, episode: match.episode, episodeEnd: match.episodeEnd });
  return code !== null ? code : cleanName(stem);
}

/**
 * Parses a series episode's identity, season/episode and title from its path
 * relative to the category folder (`Serien`/`Series`/`TV`).
 * @param {string} relInCategory `/`-separated path below the category folder
 * @param {() => number} now injected clock (epoch ms), for the series year upper bound
 * @returns {EpisodeResult} the parsed episode
 */
export function parseEpisode(relInCategory, now) {
  const segments = relInCategory.split('/');
  const stem = stripExtension(segments[segments.length - 1]);
  const ancestorFolders = segments.slice(1, -1);
  const match = detectSeasonEpisode(stem, ancestorFolders);
  const series = deriveSeries(segments, stem, match, now);
  const title = deriveEpisodeTitle(stem, match);
  return {
    seriesKey: series.seriesKey,
    seriesTitle: series.seriesTitle,
    seriesYear: series.seriesYear,
    season: match.season,
    episode: match.episode,
    episodeEnd: match.episodeEnd,
    title
  };
}
