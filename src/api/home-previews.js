// @ts-check

import { requireUser } from '../http/guards.js';
import { sendError, sendJson } from '../http/respond.js';
import { findFolderCover } from '../db/image-meta.js';
import { listGroupRows } from '../db/audio-meta-repo.js';
import {
  countHomeCategories,
  listRecentAudioGroupKeys,
  listRecentImageFolders,
  listRecentMovies,
  listRecentSeries,
} from '../db/home-queries.js';
import { buildAlbums, buildBooks } from '../library/audio-groups.js';
import { toCoverView } from '../library/gallery.js';
import { msToSeconds } from './audiobooks.js';
import { mapCover } from './gallery.js';
import { parseHomeLimit } from './home-params.js';
import { toItemJson } from './library-json.js';
import { toSeriesSummaryJson } from './library.js';

/**
 * `GET /api/home/previews`: per-category counts plus the `limit` most
 * recently added items per category, for the start page's category rows.
 * `limit` caps `items` only — `count` always reflects the whole category.
 * @typedef {{ count: number, items: import('./library-json.js').ItemJson[] }} MoviesPreview
 * @typedef {{ count: number, items: ReturnType<typeof toSeriesSummaryJson>[] }} SeriesPreview
 * @typedef {{ id: number, title: string | null, artist: string | null, year: number | null, coverId: number, trackCount: number }} AlbumPreviewItem
 * @typedef {{ id: number, title: string, author: string | null, coverId: number, fileCount: number, duration: number | null }} BookPreviewItem
 * @typedef {{ key: string, name: string, count: number, cover: { thumbUrl: string | null, thumbOrientation: number } | null }} FolderPreviewItem
 * @typedef {{
 *   movies: MoviesPreview, series: SeriesPreview,
 *   music: { count: number, items: AlbumPreviewItem[] },
 *   audiobooks: { count: number, items: BookPreviewItem[] },
 *   images: { count: number, items: FolderPreviewItem[] },
 * }} HomePreviews
 */

/**
 * The `limit` most recently added albums, reduced to their preview shape.
 * Skips a group key whose `buildAlbums` result is empty — cannot happen for
 * a key just read from `audio_meta`, but keeps this total under `tsc --strict`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} limit
 * @returns {AlbumPreviewItem[]}
 */
function recentAlbums(db, limit) {
  /** @type {AlbumPreviewItem[]} */
  const items = [];
  for (const key of listRecentAudioGroupKeys(db, 'music', limit)) {
    const [album] = buildAlbums(listGroupRows(db, key));
    if (album === undefined) continue;
    items.push({
      id: album.id, title: album.title, artist: album.artist, year: album.year,
      coverId: album.coverId, trackCount: album.members.length,
    });
  }
  return items;
}

/**
 * The `limit` most recently added books, reduced to their preview shape. See
 * {@link recentAlbums} for the empty-group guard.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} limit
 * @returns {BookPreviewItem[]}
 */
function recentBooks(db, limit) {
  /** @type {BookPreviewItem[]} */
  const items = [];
  for (const key of listRecentAudioGroupKeys(db, 'audiobooks', limit)) {
    const [book] = buildBooks(listGroupRows(db, key));
    if (book === undefined) continue;
    items.push({
      id: book.id, title: book.title, author: book.author, coverId: book.coverId,
      fileCount: book.members.length, duration: msToSeconds(book.durationMs),
    });
  }
  return items;
}

/**
 * The `limit` most recently touched top-level gallery folders, each with its
 * cover mapped to a URL the same way `GET /api/gallery` does.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} limit
 * @returns {FolderPreviewItem[]}
 */
function recentFolders(db, limit) {
  return listRecentImageFolders(db, limit).map(({ folderKey, count }) => ({
    key: folderKey,
    name: folderKey,
    count,
    cover: mapCover(toCoverView(findFolderCover(db, folderKey))),
  }));
}

/**
 * Assembles all five category previews: one counts query, then per category
 * a `LIMIT`-bound recent-items query, skipped entirely when that category's
 * count is 0 (the invariant `count === 0 ⇒ items.length === 0`; images is the
 * one case where `count > 0` can still come with `items.length === 0`, when
 * only root-level loose files exist).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} limit
 * @returns {HomePreviews}
 */
function buildPreviews(db, limit) {
  const counts = countHomeCategories(db);
  return {
    movies: { count: counts.movies, items: counts.movies === 0 ? [] : listRecentMovies(db, limit).map(toItemJson) },
    series: {
      count: counts.series,
      items: counts.series === 0 ? [] : listRecentSeries(db, limit).map(toSeriesSummaryJson),
    },
    music: { count: counts.music, items: counts.music === 0 ? [] : recentAlbums(db, limit) },
    audiobooks: { count: counts.audiobooks, items: counts.audiobooks === 0 ? [] : recentBooks(db, limit) },
    images: { count: counts.images, items: counts.images === 0 ? [] : recentFolders(db, limit) },
  };
}

/**
 * Registers `GET /api/home/previews`, behind `requireUser`; `limit` is
 * parsed by `parseHomeLimit` (default 10, range 1..20), `400 invalid_query`
 * otherwise.
 * @param {ReturnType<typeof import('../http/router.js').createRouter>} router
 * @param {{ db: import('node:sqlite').DatabaseSync }} deps
 * @returns {void}
 */
export function registerHomePreviewsRoutes(router, { db }) {
  router.add(
    'GET',
    '/api/home/previews',
    requireUser((_req, res, ctx) => {
      const limit = parseHomeLimit(ctx.url.searchParams);
      if (limit === null) {
        sendError(res, 400, 'invalid_query');
        return;
      }
      sendJson(res, 200, buildPreviews(db, limit));
    })
  );
}
