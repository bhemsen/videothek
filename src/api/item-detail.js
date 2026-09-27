// @ts-check

/**
 * Item detail JSON: extends `toItemJson` (`src/api/library-json.js`) with the
 * next-episode affordance and subtitle sidecars. Used only by
 * `GET /api/library/items/:id` (`src/api/library.js`) — every list response
 * keeps the plain `toItemJson` shape. See
 * `docs/specs/spec-video-streaming.md` Decision log ("Item detail JSON").
 * @typedef {import('../db/library-repo.js').LibraryItemRow} LibraryItemRow
 */

import { getNextEpisode } from '../db/episodes.js';
import { listSubtitles } from '../media/subtitles.js';
import { toItemJson } from './library-json.js';

/**
 * @typedef {{
 *   id: number,
 *   title: string,
 *   season: number | null,
 *   episode: number | null,
 *   episodeEnd: number | null,
 * }} NextEpisodeJson
 */

/**
 * @typedef {{ index: number, lang: string | null, label: string | null }} SubtitleJson
 */

/**
 * @typedef {import('./library-json.js').ItemJson & {
 *   next: NextEpisodeJson | null,
 *   subtitles: SubtitleJson[],
 * }} ItemDetailJson
 */

/**
 * @param {LibraryItemRow} row
 * @returns {NextEpisodeJson}
 */
function toNextEpisodeJson(row) {
  return {
    id: row.id,
    title: row.title,
    season: row.season ?? null,
    episode: row.episode ?? null,
    episodeEnd: row.episode_end ?? null,
  };
}

/**
 * Builds the single-item detail JSON: `toItemJson(row)` plus `next` (the
 * series successor from `getNextEpisode`, `null` for movies/other categories
 * or when there is none) and `subtitles` (WebVTT sidecars from
 * `listSubtitles`, `[]` for non-video items or on any discovery failure —
 * `listSubtitles` itself never throws). Sidecar filesystem paths are never
 * included in the response.
 * @param {{ db: import('node:sqlite').DatabaseSync, mediaRoot: string }} deps
 * @param {LibraryItemRow} row
 * @returns {Promise<ItemDetailJson>}
 */
export async function toItemDetailJson({ db, mediaRoot }, row) {
  const next = getNextEpisode(db, row);
  const subtitles = await listSubtitles(mediaRoot, row);
  return {
    ...toItemJson(row),
    next: next === null ? null : toNextEpisodeJson(next),
    subtitles: subtitles.map(({ index, lang, label }) => ({ index, lang, label })),
  };
}
