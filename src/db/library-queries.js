// @ts-check

/**
 * Read-side queries for the library browse API (`src/api/library.js`). All
 * writes live in `src/db/library-repo.js`; this module never imports parser
 * code (constitution: `src/db/` never imports parser code) and builds no SQL
 * by string concatenation — each sort order is its own fixed, fully literal
 * prepared statement, selected by a lookup, never interpolated.
 * @typedef {import('./library-repo.js').LibraryItemRow} LibraryItemRow
 * @typedef {import('../library/categories.js').Category} Category
 * @typedef {{
 *   id: number,
 *   title: string,
 *   year: number | null,
 *   addedAt: number,
 *   seasonCount: number,
 *   episodeCount: number,
 *   playableCount: number,
 * }} SeriesSummaryRow
 * @typedef {{ season: number | null, episodes: LibraryItemRow[] }} SeasonGroup
 * @typedef {{
 *   id: number,
 *   title: string,
 *   year: number | null,
 *   addedAt: number,
 *   seasonCount: number,
 *   episodeCount: number,
 *   playableCount: number,
 *   seasons: SeasonGroup[],
 * }} SeriesDetail
 */

const LIST_ITEMS_BY_TITLE_SQL = `
  SELECT * FROM library_items WHERE category = ?
  ORDER BY sort_title, year IS NULL, year, id
`;

const LIST_ITEMS_BY_ADDED_SQL = `
  SELECT * FROM library_items WHERE category = ?
  ORDER BY added_at DESC, mtime_ms DESC, id
`;

const SERIES_SUMMARY_SELECT = `
  SELECT
    ls.id AS id,
    ls.title AS title,
    ls.year AS year,
    MAX(li.added_at) AS addedAt,
    COUNT(DISTINCT CASE WHEN li.season >= 1 THEN li.season END) AS seasonCount,
    COUNT(*) AS episodeCount,
    SUM(li.playable) AS playableCount
  FROM library_series ls
  JOIN library_items li ON li.series_id = ls.id
  GROUP BY ls.id
`;

const LIST_SERIES_BY_TITLE_SQL = `${SERIES_SUMMARY_SELECT} ORDER BY ls.sort_title, ls.year IS NULL, ls.year, ls.id`;
const LIST_SERIES_BY_ADDED_SQL = `${SERIES_SUMMARY_SELECT} ORDER BY addedAt DESC, ls.id DESC`;

const EPISODES_BY_SERIES_SQL = `
  SELECT * FROM library_items WHERE series_id = ?
  ORDER BY
    CASE WHEN season IS NULL THEN 2 WHEN season = 0 THEN 1 ELSE 0 END,
    season,
    episode IS NULL,
    episode,
    COALESCE(episode_end, -1),
    sort_title,
    id
`;

/**
 * `node:sqlite` hands back null-prototype row objects; spread into plain
 * objects so callers (and `assert.deepEqual`) see ordinary objects.
 * @template T
 * @param {T} row
 * @returns {T}
 */
function plain(row) {
  return { ...row };
}

/**
 * Full `library_items` rows of one category, in the requested display
 * order. `sort` must already be validated by the caller (never passed
 * through from the request unchecked).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Category} category
 * @param {'title' | 'added'} sort
 * @returns {LibraryItemRow[]}
 */
export function listCategoryItems(db, category, sort) {
  const sql = sort === 'added' ? LIST_ITEMS_BY_ADDED_SQL : LIST_ITEMS_BY_TITLE_SQL;
  const rows = /** @type {unknown[]} */ (db.prepare(sql).all(category));
  return rows.map((row) => plain(/** @type {LibraryItemRow} */ (row)));
}

/**
 * One summary row per series that currently has at least one item (an
 * `INNER JOIN`, so an orphaned series with zero items never appears).
 * `seasonCount` counts only distinct seasons `>= 1` (Specials/season 0 and
 * unnumbered/`NULL` episodes are excluded); `addedAt` is the max `added_at`
 * of its episodes, not `library_series.added_at`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {'title' | 'added'} sort
 * @returns {SeriesSummaryRow[]}
 */
export function listSeries(db, sort) {
  const sql = sort === 'added' ? LIST_SERIES_BY_ADDED_SQL : LIST_SERIES_BY_TITLE_SQL;
  const rows = /** @type {unknown[]} */ (db.prepare(sql).all());
  return rows.map((row) => plain(/** @type {SeriesSummaryRow} */ (row)));
}

/**
 * Groups already season-ordered rows (per {@link EPISODES_BY_SERIES_SQL})
 * into consecutive `{ season, episodes }` runs, preserving their order:
 * seasons `1..n`, then `0` ("Specials"), then `null` ("Weitere Folgen").
 * @param {LibraryItemRow[]} rows
 * @returns {SeasonGroup[]}
 */
function groupBySeason(rows) {
  /** @type {SeasonGroup[]} */
  const seasons = [];
  /** @type {SeasonGroup | null} */
  let current = null;
  for (const row of rows) {
    const season = row.season ?? null;
    if (!current || current.season !== season) {
      current = { season, episodes: [] };
      seasons.push(current);
    }
    current.episodes.push(row);
  }
  return seasons;
}

/**
 * A series with its episodes grouped by season, for
 * `GET /api/library/series/:id`. Returns `undefined` for an unknown id or a
 * series with no items ("a series appears only while it has items").
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @returns {SeriesDetail | undefined}
 */
export function getSeriesWithEpisodes(db, id) {
  const series = /** @type {{ id: number, title: string, year: number | null } | undefined} */ (
    db.prepare('SELECT id, title, year FROM library_series WHERE id = ?').get(id)
  );
  if (!series) return undefined;

  const rows = /** @type {unknown[]} */ (db.prepare(EPISODES_BY_SERIES_SQL).all(id));
  const episodes = rows.map((row) => plain(/** @type {LibraryItemRow} */ (row)));
  if (episodes.length === 0) return undefined;

  const seasonCount = new Set(
    episodes.filter((row) => row.season !== null && row.season !== undefined && row.season >= 1).map((row) => row.season)
  ).size;
  const playableCount = episodes.reduce((count, row) => count + (row.playable ? 1 : 0), 0);
  const addedAt = Math.max(...episodes.map((row) => row.added_at));

  return {
    id: series.id,
    title: series.title,
    year: series.year ?? null,
    addedAt,
    seasonCount,
    episodeCount: episodes.length,
    playableCount,
    seasons: groupBySeason(episodes),
  };
}

/**
 * The full row (incl. `rel_path`) for one item, for
 * `GET /api/library/items/:id` and for later phases that need the on-disk
 * path. Returns `undefined` when no such id is indexed.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @returns {LibraryItemRow | undefined}
 */
export function getItemById(db, id) {
  const row = /** @type {unknown} */ (db.prepare('SELECT * FROM library_items WHERE id = ?').get(id));
  return row ? plain(/** @type {LibraryItemRow} */ (row)) : undefined;
}
