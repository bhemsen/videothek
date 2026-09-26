/**
 * All SQL for the `progress` table (`src/db/migrations/003-progress.sql`) and
 * every P4 query that joins it to `library_items`. Progress is keyed by
 * `(user_id, rel_path)` — never by `library_items.id` — so a row survives a
 * vanished-and-reappearing file (see the migration's comment; no FK to
 * `library_items`). Thresholds (e.g. the 30 s "started" cutoff) are business
 * rules owned by `src/api/progress-rules.js` and are always received here as
 * a bound parameter, never hard-coded in SQL.
 */

/**
 * @typedef {{ user_id: number, rel_path: string, position_seconds: number, duration_seconds: number, finished: 0 | 1, updated_at: number }} ProgressRow
 * @typedef {ProgressRow & import('./library-repo.js').LibraryItemRow} ProgressItemRow
 * @typedef {object} UpsertProgressInput
 * @property {number} userId
 * @property {string} relPath
 * @property {number} positionSeconds
 * @property {number} durationSeconds
 * @property {boolean} finished
 * @property {number} updatedAt - epoch ms
 */

const PROGRESS_ITEM_COLUMNS = `
  li.*,
  p.position_seconds AS position_seconds,
  p.duration_seconds AS duration_seconds,
  p.finished AS finished,
  p.updated_at AS updated_at
`;

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 * @param {string} relPath
 * @returns {ProgressRow | undefined}
 */
export function getProgressRow(db, userId, relPath) {
  const row = db
    .prepare(
      `SELECT user_id, rel_path, position_seconds, duration_seconds, finished, updated_at
       FROM progress WHERE user_id = ? AND rel_path = ?`
    )
    .get(userId, relPath);
  return /** @type {ProgressRow | undefined} */ (row);
}

/**
 * Inserts a progress row, or overwrites one matched by `(user_id, rel_path)`
 * via `ON CONFLICT … DO UPDATE` (last write wins). `user_id` and `rel_path`
 * never change on an update.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {UpsertProgressInput} input
 * @returns {ProgressRow} the row as stored
 */
export function upsertProgress(
  db,
  { userId, relPath, positionSeconds, durationSeconds, finished, updatedAt }
) {
  const row = db
    .prepare(
      `INSERT INTO progress (user_id, rel_path, position_seconds, duration_seconds, finished, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, rel_path) DO UPDATE SET
         position_seconds = excluded.position_seconds,
         duration_seconds = excluded.duration_seconds,
         finished = excluded.finished,
         updated_at = excluded.updated_at
       RETURNING user_id, rel_path, position_seconds, duration_seconds, finished, updated_at`
    )
    .get(userId, relPath, positionSeconds, durationSeconds, finished ? 1 : 0, updatedAt);
  return /** @type {ProgressRow} */ (row);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 * @param {string} relPath
 * @returns {boolean} whether a row was deleted
 */
export function deleteProgress(db, userId, relPath) {
  const result = db
    .prepare('DELETE FROM progress WHERE user_id = ? AND rel_path = ?')
    .run(userId, relPath);
  return Number(result.changes) > 0;
}

/**
 * The user's `in_progress` rows (`finished = 0` and `position_seconds >=
 * startThreshold`) for present, playable items of the requested categories —
 * the "continue" view's non-next-up half. Ordered newest-first for the
 * caller to merge with next-up entries before applying its own limit.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ userId: number, categories: string[], startThreshold: number, limit: number }} params
 * @returns {ProgressItemRow[]}
 */
export function listContinueRows(db, { userId, categories, startThreshold, limit }) {
  const rows = db
    .prepare(
      `SELECT ${PROGRESS_ITEM_COLUMNS}
       FROM progress p
       JOIN library_items li ON li.rel_path = p.rel_path
       WHERE p.user_id = ?
         AND li.playable = 1
         AND li.category IN (SELECT value FROM json_each(?))
         AND p.finished = 0
         AND p.position_seconds >= ?
       ORDER BY p.updated_at DESC, li.id DESC
       LIMIT ?`
    )
    .all(userId, JSON.stringify(categories), startThreshold, limit);
  return /** @type {ProgressItemRow[]} */ (/** @type {unknown} */ (rows));
}

/**
 * Every `in_progress` and `finished` row for present, playable items of the
 * requested categories — the "all" view used for grid decoration (no limit).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ userId: number, categories: string[], startThreshold: number }} params
 * @returns {ProgressItemRow[]}
 */
export function listStateRows(db, { userId, categories, startThreshold }) {
  const rows = db
    .prepare(
      `SELECT ${PROGRESS_ITEM_COLUMNS}
       FROM progress p
       JOIN library_items li ON li.rel_path = p.rel_path
       WHERE p.user_id = ?
         AND li.playable = 1
         AND li.category IN (SELECT value FROM json_each(?))
         AND (p.finished = 1 OR p.position_seconds >= ?)
       ORDER BY p.updated_at DESC, li.id DESC`
    )
    .all(userId, JSON.stringify(categories), startThreshold);
  return /** @type {ProgressItemRow[]} */ (/** @type {unknown} */ (rows));
}

/**
 * The user's progress rows joined to present `category = 'series'` items, in
 * every state (no threshold or playable filter — the caller derives state
 * and the playable check itself; see `src/api/progress-next-up.js`).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 * @returns {ProgressItemRow[]}
 */
export function listSeriesProgressRows(db, userId) {
  const rows = db
    .prepare(
      `SELECT ${PROGRESS_ITEM_COLUMNS}
       FROM progress p
       JOIN library_items li ON li.rel_path = p.rel_path
       WHERE p.user_id = ? AND li.category = 'series'`
    )
    .all(userId);
  return /** @type {ProgressItemRow[]} */ (/** @type {unknown} */ (rows));
}
