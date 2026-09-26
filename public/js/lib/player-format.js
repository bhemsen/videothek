/**
 * Pure, DOM-free formatting and decision helpers for the video player page
 * (`/player`). No DOM access — see docs/specs/spec-video-streaming.md
 * "Design" and its state table, unit-tested from `test/public/`.
 */

import { episodeCode } from './library-format.js';

const EN_DASH = '–';

/**
 * @typedef {object} EpisodeIdentity
 * @property {number | null} [season] - `0` for specials, `null`/absent when unknown.
 * @property {number | null} [episode] - `null`/absent when unknown.
 * @property {number | null} [episodeEnd] - End of a multi-episode range.
 */

/**
 * Resolves the display title of an episode: the parsed title, or a German
 * "Folge N" / "Folgen a–b" (en dash) fallback when the title equals the
 * language-neutral episode code case-insensitively (P2's code fallback).
 * @param {EpisodeIdentity & { title: string }} item
 * @returns {string}
 */
export function episodeTitleFor({ title, season = null, episode = null, episodeEnd = null }) {
  const code = episodeCode({ season, episode, episodeEnd });
  if (code === null || title.toLowerCase() !== code.toLowerCase()) return title;
  return episodeEnd != null ? `Folgen ${episode}${EN_DASH}${episodeEnd}` : `Folge ${episode}`;
}

/**
 * Builds "<code> · <display title>" for an episode, or just the display
 * title when the episode number is unknown (`episodeCode` is `null`).
 * @param {EpisodeIdentity & { title: string }} item
 * @returns {string}
 */
function episodeHeading({ title, season = null, episode = null, episodeEnd = null }) {
  const identity = { season, episode, episodeEnd };
  const code = episodeCode(identity);
  const displayTitle = episodeTitleFor({ title, ...identity });
  return code === null ? displayTitle : `${code} · ${displayTitle}`;
}

/**
 * @typedef {object} PlayerItem
 * @property {string} category - One of P2's `CATEGORIES` ids.
 * @property {string} title
 * @property {string | null} [seriesTitle]
 * @property {number | null} [season]
 * @property {number | null} [episode]
 * @property {number | null} [episodeEnd]
 */

/**
 * Resolves the player page overline: "Film" for a movie, the series title
 * for an episode (rendered exactly as given — no upper-casing).
 * @param {PlayerItem} item
 * @returns {string}
 */
export function overlineFor(item) {
  return item.category === 'movies' ? 'Film' : (item.seriesTitle ?? '');
}

/**
 * Resolves the player page heading: the movie title, or
 * "<code> · <display title>" for an episode.
 * @param {PlayerItem} item
 * @returns {string}
 */
export function headingFor(item) {
  return item.category === 'movies' ? item.title : episodeHeading(item);
}

/**
 * @typedef {object} NextEpisode
 * @property {number} id
 * @property {string} title
 * @property {number | null} season
 * @property {number | null} episode
 * @property {number | null} episodeEnd
 */

/**
 * Builds the "Nächste Folge: <code> · <display title>" button label from
 * the item detail API's `next` field.
 * @param {NextEpisode | null} next
 * @returns {string | null} `null` when there is no next episode.
 */
export function nextLabel(next) {
  return next == null ? null : `Nächste Folge: ${episodeHeading(next)}`;
}

/**
 * @typedef {object} SubtitleTrack
 * @property {number} index
 * @property {string | null} lang
 * @property {string | null} label
 */

const subtitleLanguageNames = new Intl.DisplayNames(['de'], { type: 'language' });

/**
 * Resolves the German display label of one subtitle track before
 * duplicate numbering: the German language name for `lang` (falling back
 * to the upper-cased code on a throw or an unchanged/unrecognized code),
 * else the free-form `label`, else "Untertitel".
 * @param {SubtitleTrack} track
 * @returns {string}
 */
function baseSubtitleLabel({ lang, label }) {
  if (lang) {
    let name = null;
    try {
      name = subtitleLanguageNames.of(lang);
    } catch {
      name = null;
    }
    return name && name.toLowerCase() !== lang.toLowerCase() ? name : lang.toUpperCase();
  }
  return label ?? 'Untertitel';
}

/**
 * Resolves the display labels for a list of subtitle tracks, in order,
 * numbering repeated labels " (2)", " (3)", ….
 * @param {SubtitleTrack[]} subtitles
 * @returns {string[]}
 */
export function subtitleLabels(subtitles) {
  const seen = new Map();
  return subtitles.map((track) => {
    const base = baseSubtitleLabel(track);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

/**
 * @typedef {'file-missing' | 'codec' | 'connection-lost'} PlaybackErrorState
 */

/**
 * Resolves which playback-error state a `<video>` `error` event maps to,
 * given the disambiguating `HEAD /media/:id` probe result (spec state
 * table): a `404` means the file is gone; any other `2xx` status means the
 * file is still there, so `MediaError.code === 2` means the connection was
 * lost while any other code means an unsupported codec; a network failure
 * or any other HTTP status also means the connection was lost.
 * @param {{ headStatus: number | null | undefined, mediaErrorCode: number }} probe
 * @returns {PlaybackErrorState}
 */
export function errorStateFor({ headStatus, mediaErrorCode }) {
  if (headStatus === 404) return 'file-missing';
  const is2xx = typeof headStatus === 'number' && headStatus >= 200 && headStatus < 300;
  if (is2xx) return mediaErrorCode === 2 ? 'connection-lost' : 'codec';
  return 'connection-lost';
}

/**
 * Decides whether "Zurück" should navigate `history.back()` or to the home
 * page: only when the referrer is same-origin, its path is not `/login`
 * (avoids a login → player back-loop), and there is a real previous page
 * (`historyLength > 1`); an empty or unparsable referrer is treated as
 * "no real previous page".
 * @param {{ referrer: string, origin: string, historyLength: number }} nav
 * @returns {'back' | 'home'}
 */
export function backTarget({ referrer, origin, historyLength }) {
  if (!referrer || historyLength <= 1) return 'home';
  let url;
  try {
    url = new URL(referrer);
  } catch {
    return 'home';
  }
  if (url.origin !== origin || url.pathname === '/login') return 'home';
  return 'back';
}
