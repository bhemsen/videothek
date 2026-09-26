/**
 * Write-side SQL for the library scanner (`src/library/`). Every column name
 * here matches `library_items`/`library_series` (see
 * `src/db/migrations/002-library.sql`) verbatim, so a row object can be
 * passed straight from `src/library/item-builder.js` into `upsertItem`
 * without a naming translation. This module never imports parser code
 * (constitution: `src/db/` never imports parser code) and never builds SQL
 * by string concatenation.
 * @typedef {object} LibraryItemInput
 * @property {string} rel_path
 * @property {string} dir
 * @property {'movies'|'series'|'music'|'audiobooks'|'images'} category
 * @property {'video'|'audio'|'image'} kind
 * @property {string} ext
 * @property {string} title
 * @property {string} sort_title
 * @property {number | null} [year]
 * @property {number | null} [series_id]
 * @property {string | null} [series_title]
 * @property {number | null} [season]
 * @property {number | null} [episode]
 * @property {number | null} [episode_end]
 * @property {string | null} [video_codec]
 * @property {string | null} [audio_codec]
 * @property {boolean} playable
 * @property {number} size
 * @property {number} mtime_ms
 * @property {number} scan_version
 * @typedef {object} LibrarySeriesInput
 * @property {string} series_key
 * @property {string} title
 * @property {string} sort_title
 * @property {number | null} [year]
 * @typedef {LibraryItemInput & { id: number, added_at: number, scanned_at: number }} LibraryItemRow
 */

const UPSERT_ITEM_SQL = `
  INSERT INTO library_items (
    rel_path, dir, category, kind, ext, title, sort_title, year,
    series_id, series_title, season, episode, episode_end,
    video_codec, audio_codec, playable, size, mtime_ms, scan_version,
    added_at, scanned_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(rel_path) DO UPDATE SET
    dir = excluded.dir, category = excluded.category, kind = excluded.kind,
    ext = excluded.ext, title = excluded.title, sort_title = excluded.sort_title,
    year = excluded.year, series_id = excluded.series_id,
    series_title = excluded.series_title, season = excluded.season,
    episode = excluded.episode, episode_end = excluded.episode_end,
    video_codec = excluded.video_codec, audio_codec = excluded.audio_codec,
    playable = excluded.playable, size = excluded.size, mtime_ms = excluded.mtime_ms,
    scan_version = excluded.scan_version, scanned_at = excluded.scanned_at
  RETURNING id
`;

const UPSERT_SERIES_SQL = `
  INSERT INTO library_series (series_key, title, sort_title, year, added_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(series_key) DO UPDATE SET
    title = excluded.title, sort_title = excluded.sort_title, year = excluded.year
  RETURNING id
`;

/**
 * Inserts a newly discovered file, or updates an already-indexed one matched
 * by `rel_path`, via `ON CONFLICT(rel_path) DO UPDATE` (never `INSERT OR
 * REPLACE`, which would assign a new id and fire `ON DELETE CASCADE` on
 * later phases' tables). `id` and `added_at` are preserved across updates;
 * every other column, including `scanned_at`, is refreshed.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {LibraryItemInput} item
 * @param {number} now - epoch ms; becomes `added_at` on first insert, and is
 *   always written as `scanned_at`
 * @returns {number} the row's id, stable across any number of updates
 */
export function upsertItem(db, item, now) {
  const row = /** @type {{ id: number }} */ (
    db
      .prepare(UPSERT_ITEM_SQL)
      .get(
        item.rel_path,
        item.dir,
        item.category,
        item.kind,
        item.ext,
        item.title,
        item.sort_title,
        item.year ?? null,
        item.series_id ?? null,
        item.series_title ?? null,
        item.season ?? null,
        item.episode ?? null,
        item.episode_end ?? null,
        item.video_codec ?? null,
        item.audio_codec ?? null,
        item.playable ? 1 : 0,
        item.size,
        item.mtime_ms,
        item.scan_version,
        now,
        now
      )
  );
  return row.id;
}

/**
 * Deletes the single item at `relPath`, if one is indexed. `AUTOINCREMENT`
 * guarantees the freed id is never handed to a later insert.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} relPath
 * @returns {boolean} whether a row was deleted
 */
export function deleteItem(db, relPath) {
  const result = db.prepare('DELETE FROM library_items WHERE rel_path = ?').run(relPath);
  return result.changes > 0;
}

/**
 * Lower/upper bound for a `rel_path` range that matches every path strictly
 * under `dir` (`dir/…`), whatever characters — including `_` and `%` — the
 * path segments contain. Never use `LIKE`, which treats those as wildcards.
 * `/` (0x2F) and `0` (0x30) are adjacent code points, so `[dir/, dir0)` is
 * exactly the set of strings starting with `dir/`.
 * @param {string} dir
 * @returns {[string, string]}
 */
function subtreeBounds(dir) {
  return [`${dir}/`, `${dir}0`];
}

/**
 * Deletes every item whose path lies anywhere under `dir` (a removed
 * directory, or a category root being swept). Uses the range-form prefix
 * match (see `subtreeBounds`), never `LIKE`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} dir
 * @returns {number} number of rows deleted
 */
export function deleteItemsUnderDir(db, dir) {
  const [lower, upper] = subtreeBounds(dir);
  const result = db
    .prepare('DELETE FROM library_items WHERE rel_path >= ? AND rel_path < ?')
    .run(lower, upper);
  return Number(result.changes);
}

/**
 * Lists every distinct `dir` value with at least one row at or under
 * `prefix` (inclusive of `prefix` itself). Used by the scanner's end-of-walk
 * sweep (`scanner.js`, #33) to find directories that still have rows but
 * were not visited by the walk that just completed — the scanner has no
 * other way to discover a whole subdirectory that vanished, since it only
 * ever asks about directories it already knows to look at.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} prefix
 * @returns {string[]}
 */
export function listDirsUnderDir(db, prefix) {
  const [lower, upper] = subtreeBounds(prefix);
  const rows = /** @type {{ dir: string }[]} */ (
    /** @type {unknown} */ (
      db
        .prepare('SELECT DISTINCT dir FROM library_items WHERE dir = ? OR (dir >= ? AND dir < ?)')
        .all(prefix, lower, upper)
    )
  );
  return rows.map((row) => row.dir);
}

/**
 * Lists the exact on-disk name of every category-root segment (the first
 * `/`-separated component of `rel_path`) that has at least one indexed item
 * under it. Root safety (D7) evaluates `discovered ∪ listIndexedRootNames(db)`
 * as its candidate set, so a root that once had files keeps being checked
 * (and re-protected) across a process restart — including the "disk
 * unmounted before the process started" case, where `discoverRoots()` alone
 * would never see it — while a category that was never used is never
 * evaluated and so never warns.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string[]}
 */
export function listIndexedRootNames(db) {
  const rows = /** @type {{ root: string }[]} */ (
    /** @type {unknown} */ (
      db.prepare("SELECT DISTINCT substr(rel_path, 1, instr(rel_path, '/') - 1) AS root FROM library_items").all()
    )
  );
  return rows.map((row) => row.root);
}

/**
 * Checks whether any indexed item lies anywhere under `dir`, without loading
 * rows. Used for root safety (D7): a category root that still has rows but
 * is missing, unreadable or empty must not be swept.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} dir
 * @returns {boolean}
 */
export function hasItemsUnderDir(db, dir) {
  const [lower, upper] = subtreeBounds(dir);
  const row = /** @type {{ found: number }} */ (
    db
      .prepare('SELECT EXISTS(SELECT 1 FROM library_items WHERE rel_path >= ? AND rel_path < ?) AS found')
      .get(lower, upper)
  );
  return row.found === 1;
}

/**
 * Loads every item directly inside `dir` (exact match on the `dir` column,
 * not recursive), for a scan to diff its current directory listing against.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} dir
 * @returns {LibraryItemRow[]} full `library_items` rows
 */
export function getItemsByDir(db, dir) {
  return /** @type {LibraryItemRow[]} */ (
    /** @type {unknown} */ (db.prepare('SELECT * FROM library_items WHERE dir = ?').all(dir))
  );
}

/**
 * Inserts a newly seen series, or updates one matched by `series_key`, via
 * `ON CONFLICT(series_key) DO UPDATE`. `id` and `added_at` are preserved
 * across updates.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {LibrarySeriesInput} series
 * @param {number} now - epoch ms; becomes `added_at` on first insert only
 * @returns {number} the row's id, stable across any number of updates
 */
export function upsertSeries(db, series, now) {
  const row = /** @type {{ id: number }} */ (
    db
      .prepare(UPSERT_SERIES_SQL)
      .get(series.series_key, series.title, series.sort_title, series.year ?? null, now)
  );
  return row.id;
}

/**
 * Deletes every `library_series` row no longer referenced by any
 * `library_items` row. Call after deleting item rows (items first, so the
 * `REFERENCES library_series(id)` foreign key holds throughout).
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number} number of series rows deleted
 */
export function deleteOrphanedSeries(db) {
  const result = db
    .prepare(
      `DELETE FROM library_series
       WHERE id NOT IN (SELECT DISTINCT series_id FROM library_items WHERE series_id IS NOT NULL)`
    )
    .run();
  return Number(result.changes);
}
