// @ts-check

/**
 * Read-side queries for `/api/home/*` (`src/api/home-listening.js`,
 * `src/api/home-previews.js`): per-category counts, recently added items for
 * the category previews, and the started-audiobook group keys for the
 * "Weiterhören" derivation. Every statement is a fixed literal prepared
 * statement with bound `?` parameters — no string-concatenated SQL. Rows are
 * spread out of `node:sqlite`'s null-prototype objects before being returned.
 */

import { SERIES_SUMMARY_SELECT } from './library-queries.js';

const COUNTS_SQL = `
  SELECT
    (SELECT COUNT(*) FROM library_items WHERE category = 'movies') AS movies,
    (SELECT COUNT(DISTINCT series_id) FROM library_items
      WHERE category = 'series' AND series_id IS NOT NULL) AS series,
    (SELECT COUNT(DISTINCT am.group_key) FROM audio_meta am
      JOIN library_items li ON li.id = am.item_id WHERE li.category = 'music') AS music,
    (SELECT COUNT(DISTINCT am.group_key) FROM audio_meta am
      JOIN library_items li ON li.id = am.item_id WHERE li.category = 'audiobooks') AS audiobooks,
    (SELECT COUNT(*) FROM image_meta) AS images
`;

// Same order as LIST_ITEMS_BY_ADDED_SQL (/movies?sort=added), plus LIMIT.
const RECENT_MOVIES_SQL = `
  SELECT * FROM library_items WHERE category = 'movies'
  ORDER BY added_at DESC, mtime_ms DESC, id
  LIMIT ?
`;

// Same order as LIST_SERIES_BY_ADDED_SQL (/series?sort=added), plus LIMIT —
// no extra tie-break, so the preview's first N are the "Alle anzeigen" page's
// first N.
const RECENT_SERIES_SQL = `${SERIES_SUMMARY_SELECT} ORDER BY addedAt DESC, ls.id DESC LIMIT ?`;

const RECENT_AUDIO_GROUPS_SQL = `
  SELECT am.group_key AS groupKey
  FROM audio_meta am
  JOIN library_items li ON li.id = am.item_id
  WHERE li.category = ?
  GROUP BY am.group_key
  ORDER BY MAX(li.added_at) DESC, MAX(li.mtime_ms) DESC, am.group_key
  LIMIT ?
`;

const RECENT_IMAGE_FOLDERS_SQL = `
  SELECT
    CASE WHEN instr(im.folder, '/') = 0 THEN im.folder
         ELSE substr(im.folder, 1, instr(im.folder, '/') - 1) END AS folderKey,
    COUNT(*) AS count
  FROM image_meta im
  JOIN library_items li ON li.id = im.item_id
  WHERE im.folder != ''
  GROUP BY folderKey
  ORDER BY MAX(li.added_at) DESC, MAX(li.mtime_ms) DESC, folderKey
  LIMIT ?
`;

const STARTED_BOOK_GROUPS_SQL = `
  SELECT DISTINCT am.group_key AS groupKey
  FROM progress p
  JOIN library_items li ON li.rel_path = p.rel_path
  JOIN audio_meta am ON am.item_id = li.id
  WHERE p.user_id = ?
    AND li.category = 'audiobooks'
    AND (p.finished = 1 OR p.position_seconds >= ?)
  ORDER BY am.group_key
`;

/**
 * Distinct `audio_meta.group_key` values of audiobooks with at least one
 * counted progress row (`finished = 1`, or started at/above `startThreshold`)
 * for the given user — the "Weiterhören" derivation's candidate set (a book
 * with no counted row can only be `new`, so it is never assembled).
 * `startThreshold` is always a bound parameter, never a literal.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ userId: number, startThreshold: number }} params
 * @returns {string[]} group keys, ordered by group_key (the listening tie-break test relies on this order)
 */
export function listStartedBookGroupKeys(db, { userId, startThreshold }) {
  const rows = /** @type {{ groupKey: string }[]} */ (
    /** @type {unknown} */ (db.prepare(STARTED_BOOK_GROUPS_SQL).all(userId, startThreshold))
  );
  return rows.map((row) => row.groupKey);
}

/**
 * Per-category item counts for the start page's previews. One statement,
 * five scalar subqueries. What each key matches on its own category page:
 * movies — every item, playable or not (`/movies` list length); series —
 * distinct `series_id` (`/api/library/series` length); music/audiobooks —
 * distinct `group_key` of items with an `audio_meta` row (album count /
 * `/api/audiobooks` length); images — `image_meta` rows, including
 * root-level loose files (gallery file count).
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ movies: number, series: number, music: number, audiobooks: number, images: number }}
 */
export function countHomeCategories(db) {
  const row = /** @type {{ movies: number, series: number, music: number, audiobooks: number, images: number }} */ (
    db.prepare(COUNTS_SQL).get()
  );
  return { ...row };
}

/**
 * The `limit` most recently added `movies` items, in the same order as
 * `/movies?sort=added`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} limit
 * @returns {import('./library-repo.js').LibraryItemRow[]}
 */
export function listRecentMovies(db, limit) {
  const rows = /** @type {unknown[]} */ (db.prepare(RECENT_MOVIES_SQL).all(limit));
  return rows.map((row) => ({ ...(/** @type {import('./library-repo.js').LibraryItemRow} */ (row)) }));
}

/**
 * The `limit` most recently added series, in the same order as
 * `/series?sort=added`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} limit
 * @returns {import('./library-queries.js').SeriesSummaryRow[]}
 */
export function listRecentSeries(db, limit) {
  const rows = /** @type {unknown[]} */ (db.prepare(RECENT_SERIES_SQL).all(limit));
  return rows.map((row) => ({ ...(/** @type {import('./library-queries.js').SeriesSummaryRow} */ (row)) }));
}

/**
 * The `limit` most recently added `music`/`audiobooks` group keys (one per
 * album/book), newest group first — an item without an `audio_meta` row is
 * excluded (the `INNER JOIN`).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {'music' | 'audiobooks'} category
 * @param {number} limit
 * @returns {string[]}
 */
export function listRecentAudioGroupKeys(db, category, limit) {
  const rows = /** @type {{ groupKey: string }[]} */ (
    /** @type {unknown} */ (db.prepare(RECENT_AUDIO_GROUPS_SQL).all(category, limit))
  );
  return rows.map((row) => row.groupKey);
}

/**
 * The `limit` top-level gallery folders with the most recently added
 * content, each with its own subtree file count (root-level loose files are
 * excluded — they have no top-level folder key).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} limit
 * @returns {{ folderKey: string, count: number }[]}
 */
export function listRecentImageFolders(db, limit) {
  const rows = /** @type {{ folderKey: string, count: number }[]} */ (
    /** @type {unknown} */ (db.prepare(RECENT_IMAGE_FOLDERS_SQL).all(limit))
  );
  return rows.map((row) => ({ ...row }));
}
