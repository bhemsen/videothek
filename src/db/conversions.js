/**
 * All SQL for the `conversions` table (`src/db/migrations/006-conversions.sql`).
 * Rows are keyed by `rel_path`, the same stable natural key `progress` uses,
 * with no foreign key and no cascade: a vanished source keeps its row so a
 * reappearing (or renamed-back) file re-attaches to it. `claimNextConversion`,
 * `publishConversion` and `failConversion` run as synchronous `BEGIN
 * IMMEDIATE` … `COMMIT`/`ROLLBACK` chunks with no `await` inside (pattern of
 * `src/db/users.js`), so they never interleave with the scanner's
 * transactions.
 * @typedef {'web' | 'flac' | 'opus'} ConversionTarget
 * @typedef {'queued' | 'converting' | 'playable' | 'failed'} ConversionStatus
 * @typedef {object} ConversionRow
 * @property {string} rel_path
 * @property {string} storage_key
 * @property {ConversionTarget} target
 * @property {ConversionStatus} status
 * @property {number} source_size
 * @property {number} source_mtime_ms
 * @property {string | null} output_rel
 * @property {number | null} output_size
 * @property {string} notes
 * @property {string} sidecars JSON array of `{ file, lang }` (`sub-<n>.vtt` in the copy's storage_key directory)
 * @property {string | null} error
 * @property {string | null} error_detail
 * @property {number} queued_at
 * @property {number | null} started_at
 * @property {number | null} finished_at
 * @property {number | null} missing_since
 */

/**
 * @param {Record<string, import('node:sqlite').SQLOutputValue>} row
 * @returns {ConversionRow}
 */
function toConversionRow(row) {
  return /** @type {ConversionRow} */ (row);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} relPath
 * @returns {ConversionRow | undefined}
 */
export function getConversion(db, relPath) {
  const row = db.prepare('SELECT * FROM conversions WHERE rel_path = ?').get(relPath);
  return row ? toConversionRow(row) : undefined;
}

/**
 * The row for `itemRow`, only if it is a **fresh** copy: `playable` and its
 * recorded source size/mtime still match the item's current ones. A stale or
 * non-`playable` row (including none at all) yields `undefined`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ rel_path: string, size: number, mtime_ms: number }} itemRow
 * @returns {ConversionRow | undefined}
 */
export function getFreshConversion(db, itemRow) {
  const row = db
    .prepare(
      `SELECT * FROM conversions
       WHERE rel_path = ? AND status = 'playable' AND source_size = ? AND source_mtime_ms = ?`
    )
    .get(itemRow.rel_path, itemRow.size, itemRow.mtime_ms);
  return row ? toConversionRow(row) : undefined;
}

/**
 * Queues a conversion for `relPath`: inserts a new row, or re-queues an
 * existing one via `ON CONFLICT(rel_path) DO UPDATE`. Covers a first
 * request, a retry after `failed`, and a re-conversion of a stale copy alike.
 * Re-queueing resets `notes` to `'[]'` and clears `error`/`error_detail`/
 * `started_at`/`finished_at`, but leaves a prior `output_rel`/`output_size`
 * in place until the new run replaces them (likewise `sidecars`), and clears
 * `missing_since`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ relPath: string, storageKey: string, target: ConversionTarget, sourceSize: number, sourceMtimeMs: number, now: number }} input
 * @returns {void}
 */
export function enqueueConversion(db, { relPath, storageKey, target, sourceSize, sourceMtimeMs, now }) {
  db.prepare(
    `INSERT INTO conversions (
       rel_path, storage_key, target, status, source_size, source_mtime_ms,
       notes, queued_at
     ) VALUES (?, ?, ?, 'queued', ?, ?, '[]', ?)
     ON CONFLICT(rel_path) DO UPDATE SET
       storage_key = excluded.storage_key,
       target = excluded.target,
       status = 'queued',
       source_size = excluded.source_size,
       source_mtime_ms = excluded.source_mtime_ms,
       notes = '[]',
       error = NULL,
       error_detail = NULL,
       started_at = NULL,
       finished_at = NULL,
       missing_since = NULL,
       queued_at = excluded.queued_at`
  ).run(relPath, storageKey, target, sourceSize, sourceMtimeMs, now);
}

/**
 * Claims the oldest `queued` row (FIFO by `queued_at`, ties broken by
 * `rel_path`) and marks it `converting`, whether or not `library_items`
 * still has a row at that path. Runs as one `BEGIN IMMEDIATE` transaction so
 * two overlapping calls can never both claim the same row.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} now
 * @returns {ConversionRow | undefined} the claimed row (already `converting`), or `undefined` when nothing is queued
 */
export function claimNextConversion(db, now) {
  try {
    db.exec('BEGIN IMMEDIATE');
    const row = /** @type {ConversionRow | undefined} */ (
      db
        .prepare(
          `SELECT * FROM conversions WHERE status = 'queued' ORDER BY queued_at ASC, rel_path ASC LIMIT 1`
        )
        .get()
    );
    if (!row) {
      db.exec('ROLLBACK');
      return undefined;
    }
    db.prepare("UPDATE conversions SET status = 'converting', started_at = ? WHERE rel_path = ?").run(
      now,
      row.rel_path
    );
    db.exec('COMMIT');
    return toConversionRow({ ...row, status: 'converting', started_at: now });
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // No transaction to roll back, e.g. BEGIN itself failed; the original
      // error below is what matters.
    }
    throw err;
  }
}

/**
 * Overwrites the recorded source stat of a row (job start re-stat).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} relPath
 * @param {number} size
 * @param {number} mtimeMs
 * @returns {boolean} whether a row was updated
 */
export function recordSourceStat(db, relPath, size, mtimeMs) {
  const result = db
    .prepare('UPDATE conversions SET source_size = ?, source_mtime_ms = ? WHERE rel_path = ?')
    .run(size, mtimeMs, relPath);
  return Number(result.changes) > 0;
}

/**
 * Publishes a verified copy: marks the row `playable` and, in the same
 * transaction, sets `library_items.playable = 1` for that `rel_path` — but
 * only when its current `size`/`mtime_ms` still match the source stat this
 * conversion was made from (recorded by `recordSourceStat` at job start), so
 * a source that changed mid-conversion never gets marked playable from a
 * stale copy.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ relPath: string, outputRel: string, outputSize: number, notes: string, sidecars: string, now: number }} input
 * @returns {void}
 */
export function publishConversion(db, { relPath, outputRel, outputSize, notes, sidecars, now }) {
  try {
    db.exec('BEGIN IMMEDIATE');
    const source = /** @type {{ source_size: number, source_mtime_ms: number } | undefined} */ (
      db.prepare('SELECT source_size, source_mtime_ms FROM conversions WHERE rel_path = ?').get(relPath)
    );
    db.prepare(
      `UPDATE conversions SET
         status = 'playable', output_rel = ?, output_size = ?, notes = ?, sidecars = ?,
         error = NULL, error_detail = NULL, finished_at = ?
       WHERE rel_path = ?`
    ).run(outputRel, outputSize, notes, sidecars, now, relPath);
    if (source) {
      db.prepare('UPDATE library_items SET playable = 1 WHERE rel_path = ? AND size = ? AND mtime_ms = ?').run(
        relPath,
        source.source_size,
        source.source_mtime_ms
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // No transaction to roll back, e.g. BEGIN itself failed; the original
      // error below is what matters.
    }
    throw err;
  }
}

/**
 * Ends a row as `failed` with a reason. Runs as its own `BEGIN IMMEDIATE`
 * transaction per the queue's synchronous-write rule, even though it is a
 * single statement, so it never interleaves with a concurrent scanner write.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ relPath: string, error: string, detail: string | null, now: number }} input
 * @returns {void}
 */
export function failConversion(db, { relPath, error, detail, now }) {
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare(
      "UPDATE conversions SET status = 'failed', error = ?, error_detail = ?, finished_at = ? WHERE rel_path = ?"
    ).run(error, detail, now, relPath);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // No transaction to roll back, e.g. BEGIN itself failed; the original
      // error below is what matters.
    }
    throw err;
  }
}

/**
 * Cancels a still-`queued` row: guarded so a `converting`/`playable`/`failed`
 * row is never touched. Ends as `failed` with `error = 'cancelled'`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ relPath: string, now: number }} input
 * @returns {boolean} whether a queued row was cancelled
 */
export function cancelQueuedConversion(db, { relPath, now }) {
  try {
    db.exec('BEGIN IMMEDIATE');
    const result = db
      .prepare(
        "UPDATE conversions SET status = 'failed', error = 'cancelled', error_detail = NULL, finished_at = ? WHERE rel_path = ? AND status = 'queued'"
      )
      .run(now, relPath);
    db.exec('COMMIT');
    return Number(result.changes) > 0;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // No transaction to roll back; the original error below is what matters.
    }
    throw err;
  }
}

/**
 * Recovery at every startup (feature on or off): turns every row still
 * `converting` from a crash or a prior restart into `failed` `interrupted`.
 * `queued` rows are left untouched so they run on the next `kick()`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} now
 * @returns {number} the number of rows recovered
 */
export function failInterruptedConversions(db, now) {
  const result = db
    .prepare(
      "UPDATE conversions SET status = 'failed', error = 'interrupted', finished_at = ? WHERE status = 'converting'"
    )
    .run(now);
  return Number(result.changes);
}

/**
 * Total storage used by every copy this table still references, including
 * one whose `library_items` row has since vanished (Phase 8 cleanup territory,
 * not this phase's concern — the admin panel shows the true total).
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ bytes: number, count: number }}
 */
export function getConversionUsage(db) {
  const row = /** @type {{ bytes: number, count: number }} */ (
    db
      .prepare('SELECT COALESCE(SUM(output_size), 0) AS bytes, COUNT(*) AS count FROM conversions WHERE output_rel IS NOT NULL')
      .get()
  );
  return { bytes: row.bytes, count: row.count };
}
