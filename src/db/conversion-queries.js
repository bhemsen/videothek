/**
 * Read-side SQL joining `conversions` to `library_items` for the admin
 * "Konvertierung" panel and the conversion-control decorator. Split out of
 * `src/db/conversions.js` to stay under the constitution's 300-line limit
 * (spec-conversion-core.md, Repository).
 *
 * Every row keeps `library_items` columns under their plain names (`li.*`),
 * so it can be passed straight into `toItemJson` (`src/api/library-json.js`);
 * every `conversions` column is aliased with a `c_` prefix, because both
 * tables have `rel_path` and a plain `c.*` would shadow the item's own.
 *
 * `position` is the 1-based FIFO position among every `queued` row whose item
 * is currently present in `library_items` (queue order: `queued_at,
 * rel_path`), numbered in a CTE over **all** such visible rows before any
 * `ids` filter is applied — numbering only the requested rows would give
 * wrong "Platz N" values. It is `null` for a non-queued row; the one
 * `converting` job is never counted (nor does it consume a position slot for
 * the rows behind it). A `queued` row whose item is absent from
 * `library_items` is excluded from the numbering entirely (it is claimed and
 * run like any other row, just never shown or counted).
 * @typedef {import('./library-repo.js').LibraryItemRow & {
 *   c_rel_path: string | null,
 *   c_storage_key: string | null,
 *   c_target: import('./conversions.js').ConversionTarget | null,
 *   c_status: import('./conversions.js').ConversionStatus | null,
 *   c_source_size: number | null,
 *   c_source_mtime_ms: number | null,
 *   c_output_rel: string | null,
 *   c_output_size: number | null,
 *   c_notes: string | null,
 *   c_error: string | null,
 *   c_error_detail: string | null,
 *   c_queued_at: number | null,
 *   c_started_at: number | null,
 *   c_finished_at: number | null,
 *   position: number | null,
 * }} ConversionListRow
 */

const QUEUE_POSITION_CTE = `
  WITH queue_position AS (
    SELECT c.rel_path AS rel_path,
           ROW_NUMBER() OVER (ORDER BY c.queued_at, c.rel_path) AS position
    FROM conversions c
    JOIN library_items li ON li.rel_path = c.rel_path
    WHERE c.status = 'queued'
  )
`;

const CONVERSION_COLUMNS = `
  c.rel_path        AS c_rel_path,
  c.storage_key     AS c_storage_key,
  c.target          AS c_target,
  c.status          AS c_status,
  c.source_size     AS c_source_size,
  c.source_mtime_ms AS c_source_mtime_ms,
  c.output_rel      AS c_output_rel,
  c.output_size     AS c_output_size,
  c.notes           AS c_notes,
  c.error           AS c_error,
  c.error_detail    AS c_error_detail,
  c.queued_at       AS c_queued_at,
  c.started_at      AS c_started_at,
  c.finished_at     AS c_finished_at
`;

/**
 * @param {Record<string, import('node:sqlite').SQLOutputValue>[]} rows
 * @returns {ConversionListRow[]}
 */
function toConversionListRows(rows) {
  return /** @type {ConversionListRow[]} */ (/** @type {unknown} */ (rows));
}

/**
 * Every conversion row whose `rel_path` is present in `library_items`
 * (an `INNER JOIN`, so a row whose item has vanished is omitted). Used by the
 * admin panel's queue view.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {ConversionListRow[]}
 */
export function listConversionRows(db) {
  const rows = db
    .prepare(
      `${QUEUE_POSITION_CTE}
       SELECT li.*, ${CONVERSION_COLUMNS}, qp.position AS position
       FROM conversions c
       JOIN library_items li ON li.rel_path = c.rel_path
       LEFT JOIN queue_position qp ON qp.rel_path = c.rel_path
       ORDER BY c.queued_at, c.rel_path`
    )
    .all();
  return toConversionListRows(rows);
}

/**
 * One row per requested item id that is present in `library_items` (a
 * `LEFT JOIN` to `conversions`, so an item with no conversion row still comes
 * back, with every `c_*` column and `position` `null`); an id absent from
 * `library_items` is omitted. `ids` is bound as one JSON array via
 * `json_each(?)`, so an empty list simply yields no rows without a special
 * case here.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} ids
 * @returns {ConversionListRow[]}
 */
export function listConversionRowsForIds(db, ids) {
  const rows = db
    .prepare(
      `${QUEUE_POSITION_CTE}
       SELECT li.*, ${CONVERSION_COLUMNS}, qp.position AS position
       FROM library_items li
       LEFT JOIN conversions c ON c.rel_path = li.rel_path
       LEFT JOIN queue_position qp ON qp.rel_path = li.rel_path
       WHERE li.id IN (SELECT value FROM json_each(?))
       ORDER BY li.id`
    )
    .all(JSON.stringify(ids));
  return toConversionListRows(rows);
}
