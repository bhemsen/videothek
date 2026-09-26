/**
 * Library browse API client (`GET /api/library/*`), thin wrappers over P1's
 * `request` — see docs/specs/spec-library-video.md "API contract".
 */

import { request } from './api.js';

/** @typedef {'movies' | 'series' | 'music' | 'audiobooks' | 'images'} LibraryCategory */
/** @typedef {'title' | 'added'} LibrarySort */

/**
 * @typedef {object} LibraryItem
 * @property {number} id
 * @property {LibraryCategory} category
 * @property {'video' | 'audio' | 'image'} kind
 * @property {string} title
 * @property {number | null} year
 * @property {string} ext
 * @property {number} size
 * @property {boolean} playable
 * @property {string | null} videoCodec
 * @property {string | null} audioCodec
 * @property {string} addedAt
 * @property {number | null} seriesId
 * @property {string | null} seriesTitle
 * @property {number | null} season
 * @property {number | null} episode
 * @property {number | null} episodeEnd
 * @property {string} fileName
 */

/**
 * @typedef {object} SeriesSummary
 * @property {number} id
 * @property {string} title
 * @property {number | null} year
 * @property {number} seasonCount
 * @property {number} episodeCount
 * @property {number} playableCount
 * @property {string} addedAt
 */

/** @typedef {{ running: boolean, lastCompletedAt: string | null }} ScanStatus */

/**
 * @typedef {object} CategoryItemsResponse
 * @property {LibraryCategory} category
 * @property {LibrarySort} sort
 * @property {ScanStatus} scan
 * @property {LibraryItem[]} items
 */

/**
 * @typedef {object} CategorySeriesResponse
 * @property {'series'} category
 * @property {LibrarySort} sort
 * @property {ScanStatus} scan
 * @property {SeriesSummary[]} series
 */

/** @typedef {{ season: number | null, episodes: LibraryItem[] }} SeriesSeason */

/**
 * @typedef {object} SeriesDetail
 * @property {number} id
 * @property {string} title
 * @property {number | null} year
 * @property {string} addedAt
 * @property {number} seasonCount
 * @property {number} episodeCount
 * @property {number} playableCount
 * @property {SeriesSeason[]} seasons
 */

/**
 * Fetches one category's browse list (movies/music/audiobooks/images) or,
 * for `'series'`, the series summary list.
 * @param {LibraryCategory} category
 * @param {LibrarySort} [sort] - Omitted = server default (`title`).
 * @returns {Promise<CategoryItemsResponse | CategorySeriesResponse>}
 */
export async function getCategory(category, sort) {
  const query = sort ? `?sort=${encodeURIComponent(sort)}` : '';
  const { data } = await request('GET', `/api/library/${encodeURIComponent(category)}${query}`);
  return /** @type {CategoryItemsResponse | CategorySeriesResponse} */ (data);
}

/**
 * Fetches one series' detail (seasons + episodes).
 * @param {number | string} id
 * @returns {Promise<SeriesDetail>}
 */
export async function getSeries(id) {
  const { data } = await request('GET', `/api/library/series/${encodeURIComponent(id)}`);
  return /** @type {SeriesDetail} */ (data);
}
