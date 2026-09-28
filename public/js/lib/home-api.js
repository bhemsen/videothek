/**
 * Home overview API client (`GET /api/home/*`), thin wrappers over P1's
 * `request`. Response types mirror the server's `home-listening.js`/
 * `home-previews.js` shapes and are redeclared here since `public/` never
 * imports `src/` — see docs/architecture.md "Start page" and key flow 8.
 */
import { request } from './api.js';

/** @typedef {import('./library-api.js').LibraryItem} LibraryItem */
/** @typedef {import('./library-api.js').SeriesSummary} SeriesSummary */
/** @typedef {import('../image-tiles.js').GalleryFolder} GalleryFolder */

/**
 * @typedef {{
 *   kind: 'music', trackId: number, albumId: number, title: string,
 *   artist: string | null, albumTitle: string | null, coverId: number,
 *   position: number, duration: number | null, updatedAt: string,
 * }} MusicListeningItem
 */
/**
 * @typedef {{
 *   kind: 'audiobook', id: number, title: string, author: string | null,
 *   coverId: number, fraction: number | null, remaining: number | null,
 *   updatedAt: string, resume: { itemId: number, position: number, fileTitle: string },
 * }} AudiobookListeningItem
 */
/** @typedef {MusicListeningItem | AudiobookListeningItem} ListeningItem */

/** @typedef {{ id: number, title: string | null, artist: string | null, year: number | null, coverId: number, trackCount: number }} AlbumPreview */
/** @typedef {{ id: number, title: string, author: string | null, coverId: number, fileCount: number, duration: number | null }} BookPreview */
/**
 * @typedef {{
 *   movies: { count: number, items: LibraryItem[] },
 *   series: { count: number, items: SeriesSummary[] },
 *   music: { count: number, items: AlbumPreview[] },
 *   audiobooks: { count: number, items: BookPreview[] },
 *   images: { count: number, items: GalleryFolder[] },
 * }} HomePreviews
 */

/**
 * Fetches the start page's "Weiterhören" items (server default limit 10).
 * @returns {Promise<ListeningItem[]>}
 */
export async function getListening() {
  const { data } = await request('GET', '/api/home/listening');
  return /** @type {{ items: ListeningItem[] }} */ (data).items;
}

/**
 * Fetches the start page's per-category previews (server default limit 10).
 * @returns {Promise<HomePreviews>}
 */
export async function getPreviews() {
  const { data } = await request('GET', '/api/home/previews');
  return /** @type {HomePreviews} */ (data);
}
