// @ts-check

/**
 * All SQL for the queue-owned cleanup pass (`src/convert/cleanup.js`,
 * `docs/specs/spec-converter-adapter.md`, "Cleanup rules"). Every rule changes
 * the DB first; the caller removes the directory second. Multi-statement
 * changes run as synchronous `BEGIN IMMEDIATE` ... `COMMIT` chunks (pattern of
 * `src/db/conversions.js`).
 * @typedef {import('node:sqlite').DatabaseSync} DatabaseSync
 * @typedef {{ rel_path: string, storage_key: string }} CleanupKey
 * @typedef {CleanupKey & { source_size: number, source_mtime_ms: number }} CleanupSource
 * @typedef {CleanupKey & { output_rel: string | null }} CleanupOutput
 */

/**
 * @template T
 * @param {DatabaseSync} db
 * @param {() => T} fn
 * @returns {T}
 */
function inTransaction(db, fn) {
  try {
    db.exec('BEGIN IMMEDIATE');
    const value = fn();
    db.exec('COMMIT');
    return value;
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
 * Rule 1: sets `missing_since = now` on rows whose `rel_path` is not in
 * `library_items` (and have none yet); clears it on rows whose item is back.
 * @param {DatabaseSync} db
 * @param {number} now
 * @returns {{ marked: number, cleared: number }}
 */
export function syncMissingSince(db, now) {
  return inTransaction(db, () => {
    const marked = db
      .prepare(
        `UPDATE conversions SET missing_since = ?
         WHERE missing_since IS NULL AND rel_path NOT IN (SELECT rel_path FROM library_items)`
      )
      .run(now);
    const cleared = db
      .prepare(
        `UPDATE conversions SET missing_since = NULL
         WHERE missing_since IS NOT NULL AND rel_path IN (SELECT rel_path FROM library_items)`
      )
      .run();
    return { marked: Number(marked.changes), cleared: Number(cleared.changes) };
  });
}

/**
 * Rule 2 (select): rows of any status except `converting` whose source has
 * been missing since before `cutoff`.
 * @param {DatabaseSync} db
 * @param {number} cutoff - epoch ms; `missing_since` strictly older qualifies
 * @returns {CleanupKey[]}
 */
export function listExpiredMissing(db, cutoff) {
  return /** @type {CleanupKey[]} */ (
    db
      .prepare(
        `SELECT rel_path, storage_key FROM conversions
         WHERE status != 'converting' AND missing_since IS NOT NULL AND missing_since < ?
         ORDER BY rel_path`
      )
      .all(cutoff)
  );
}

/**
 * Rule 2 (delete): guarded again so a row re-queued or claimed in between
 * survives.
 * @param {DatabaseSync} db
 * @param {string} relPath
 * @param {number} cutoff
 * @returns {boolean} whether the row was deleted
 */
export function deleteExpiredMissing(db, relPath, cutoff) {
  const result = db
    .prepare(
      `DELETE FROM conversions
       WHERE rel_path = ? AND status != 'converting' AND missing_since IS NOT NULL AND missing_since < ?`
    )
    .run(relPath, cutoff);
  return Number(result.changes) > 0;
}

/**
 * Rule 3 (select): `playable` rows that still have a `library_items` row.
 * @param {DatabaseSync} db
 * @returns {CleanupSource[]}
 */
export function listPlayableWithItem(db) {
  return /** @type {CleanupSource[]} */ (
    db
      .prepare(
        `SELECT c.rel_path, c.storage_key, c.source_size, c.source_mtime_ms
         FROM conversions c JOIN library_items i ON i.rel_path = c.rel_path
         WHERE c.status = 'playable' ORDER BY c.rel_path`
      )
      .all()
  );
}

/**
 * Rules 3 and 5 (delete): deletes a still-`playable` row and, in the same
 * transaction, sets its item to `playable = 0, scan_version = 0` so the next
 * scan recomputes the true flag (until then `/media/:id` must not stream the
 * not-playable original).
 * @param {DatabaseSync} db
 * @param {string} relPath
 * @param {string} storageKey
 * @returns {boolean} whether the row was deleted
 */
export function deletePlayableAndResetItem(db, relPath, storageKey) {
  return inTransaction(db, () => {
    const result = db
      .prepare("DELETE FROM conversions WHERE rel_path = ? AND storage_key = ? AND status = 'playable'")
      .run(relPath, storageKey);
    if (Number(result.changes) === 0) return false;
    db.prepare('UPDATE library_items SET playable = 0, scan_version = 0 WHERE rel_path = ?').run(relPath);
    return true;
  });
}

/**
 * Rule 4 (select): `failed` rows that still carry an `output_rel`.
 * @param {DatabaseSync} db
 * @returns {CleanupKey[]}
 */
export function listFailedWithOutput(db) {
  return /** @type {CleanupKey[]} */ (
    db
      .prepare(
        "SELECT rel_path, storage_key FROM conversions WHERE status = 'failed' AND output_rel IS NOT NULL ORDER BY rel_path"
      )
      .all()
  );
}

/**
 * Rule 4 (update): nulls `output_rel`/`output_size` and resets `sidecars` to
 * `'[]'` (the column is `NOT NULL DEFAULT '[]'`).
 * @param {DatabaseSync} db
 * @param {string} relPath
 * @returns {boolean} whether a row was stripped
 */
export function stripFailedOutput(db, relPath) {
  const result = db
    .prepare(
      `UPDATE conversions SET output_rel = NULL, output_size = NULL, sidecars = '[]'
       WHERE rel_path = ? AND status = 'failed' AND output_rel IS NOT NULL`
    )
    .run(relPath);
  return Number(result.changes) > 0;
}

/**
 * Rule 5 (select): fresh `playable` rows (recorded source stat equals the
 * item's) that have an `output_rel`.
 * @param {DatabaseSync} db
 * @returns {CleanupOutput[]}
 */
export function listFreshPlayable(db) {
  return /** @type {CleanupOutput[]} */ (
    db
      .prepare(
        `SELECT c.rel_path, c.storage_key, c.output_rel
         FROM conversions c JOIN library_items i ON i.rel_path = c.rel_path
         WHERE c.status = 'playable' AND c.output_rel IS NOT NULL
           AND c.source_size = i.size AND c.source_mtime_ms = i.mtime_ms
         ORDER BY c.rel_path`
      )
      .all()
  );
}

/**
 * Unmounted-disk guard input: every row that records a copy.
 * @param {DatabaseSync} db
 * @returns {CleanupOutput[]}
 */
export function listWithOutput(db) {
  return /** @type {CleanupOutput[]} */ (
    db
      .prepare('SELECT rel_path, storage_key, output_rel FROM conversions WHERE output_rel IS NOT NULL ORDER BY rel_path')
      .all()
  );
}

/**
 * "Referenced" (rule 6): the `storage_key` belongs to a row with
 * `output_rel IS NOT NULL` or with status `queued`/`converting`.
 * @param {DatabaseSync} db
 * @param {string} storageKey
 * @returns {boolean}
 */
export function isKeyReferenced(db, storageKey) {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM conversions
       WHERE storage_key = ? AND (output_rel IS NOT NULL OR status IN ('queued', 'converting')) LIMIT 1`
    )
    .get(storageKey);
  return row !== undefined;
}
