// @ts-check

/**
 * Conversion entry/envelope JSON building and `ids` query parsing for
 * `GET`/`POST /api/conversions` (`src/api/conversions.js`,
 * spec-conversion-core.md "API contract"). Pure: no DB access, no I/O. Every
 * function here works on a row already joined by
 * `src/db/conversion-queries.js` (`ConversionListRow`, `library_items` under
 * its plain column names plus every `conversions` column under a `c_`
 * prefix), or on the raw `ids` query string.
 */

import { toItemJson } from './library-json.js';
import { isConvertible, targetFor } from '../convert/targets.js';

/** @typedef {import('../db/conversion-queries.js').ConversionListRow} ConversionListRow */
/** @typedef {import('./library-json.js').ItemJson} ItemJson */

/** @typedef {'none' | 'queued' | 'converting' | 'playable' | 'stale' | 'failed'} ConversionStatus */

/**
 * @typedef {{
 *   itemId: number,
 *   item: ItemJson,
 *   convertible: boolean,
 *   target: 'web' | 'flac' | 'opus' | null,
 *   status: ConversionStatus,
 *   cancelling: boolean,
 *   position: number | null,
 *   error: string | null,
 *   errorDetail: string | null,
 *   notes: string[],
 *   outputSize: number | null,
 *   queuedAt: string | null,
 *   startedAt: string | null,
 *   finishedAt: string | null,
 * }} ConversionEntry
 */

/** Group order for the `GET /api/conversions` listing without `ids`. */
const GROUP_ORDER = Object.freeze(
  /** @type {ConversionStatus[]} */ (['converting', 'queued', 'failed', 'stale', 'playable'])
);

/** One `ids` token: the media route's `:id` syntax (1-16 digits, no leading zero). */
const ID_TOKEN_RE = /^[1-9][0-9]{0,15}$/;

/** Max number of ids `GET /api/conversions?ids=` accepts in one request. */
const MAX_IDS = 500;

/**
 * Derives the API status of a joined conversion row: `none` when it has no
 * `conversions` row at all (`c_status` is `NULL`); a stored `playable` row is
 * `stale` instead when its recorded source size/mtime no longer match the
 * item's current ones (spec-conversion-core.md "conversions" table, "A copy
 * is fresh iff..."); every other stored status passes through unchanged.
 * @param {ConversionListRow} row
 * @returns {ConversionStatus}
 */
export function deriveConversionStatus(row) {
  if (row.c_status === null) return 'none';
  if (row.c_status === 'playable') {
    const fresh = row.c_source_size === row.size && row.c_source_mtime_ms === row.mtime_ms;
    return fresh ? 'playable' : 'stale';
  }
  return row.c_status;
}

/**
 * Parses a stored `notes` column (JSON array, `'[]'` when unset) into its
 * value; a row with no `conversions` row (`c_notes` is `NULL`) has no notes.
 * @param {string | null} raw
 * @returns {string[]}
 */
function parseNotes(raw) {
  return raw === null ? [] : /** @type {string[]} */ (JSON.parse(raw));
}

/**
 * Epoch-ms column to an ISO-8601 string, `null` passed through unchanged.
 * @param {number | null} ms
 * @returns {string | null}
 */
function toIsoOrNull(ms) {
  return ms === null ? null : new Date(ms).toISOString();
}

/**
 * Builds one entry of the `GET`/`POST /api/conversions` response
 * (spec-conversion-core.md "API contract", "Entry JSON") from a joined row.
 * `cancelling` is true only for a `converting` row whose `rel_path` is the
 * queue's pending-cancel path (the queue keeps reporting it briefly after
 * the job wrote its end state, hence the status check).
 * @param {ConversionListRow} row
 * @param {string | null} [cancellingRelPath] `queue.cancellingRelPath()`
 * @returns {ConversionEntry}
 */
export function buildConversionEntry(row, cancellingRelPath = null) {
  const status = deriveConversionStatus(row);
  return {
    itemId: row.id,
    item: toItemJson(row),
    convertible: isConvertible(row),
    target: targetFor(row),
    status,
    cancelling: status === 'converting' && cancellingRelPath !== null && row.rel_path === cancellingRelPath,
    position: row.position,
    error: row.c_error,
    errorDetail: row.c_error_detail,
    notes: parseNotes(row.c_notes),
    outputSize: row.c_output_size,
    queuedAt: toIsoOrNull(row.c_queued_at),
    startedAt: toIsoOrNull(row.c_started_at),
    finishedAt: toIsoOrNull(row.c_finished_at),
  };
}

/**
 * Sort key for one group of the `ids`-less listing: ascending for `queued`
 * (its FIFO `position`, always set for a row visible in `rows`), descending
 * (newest first) for every other group, by `finished_at` else `queued_at`
 * (spec-conversion-core.md "API contract", "GET without ids").
 * @param {ConversionListRow} row
 * @param {ConversionStatus} status the row's own derived status (its group)
 * @returns {number} ascending sort key (already negated for the descending groups)
 */
function sortKey(row, status) {
  if (status === 'queued') return row.position ?? 0;
  return -(row.c_finished_at ?? row.c_queued_at ?? 0);
}

/**
 * Builds the `GET /api/conversions` listing without `ids`: every row grouped
 * `converting`, `queued`, `failed`, `stale`, `playable`, in that group order
 * (spec-conversion-core.md "API contract"). `rows` must already be
 * conversion rows joined to `library_items` (`listConversionRows`), so every
 * one has a real status — `none` never appears in this listing.
 * @param {ConversionListRow[]} rows
 * @param {string | null} [cancellingRelPath] `queue.cancellingRelPath()`
 * @returns {ConversionEntry[]}
 */
export function buildConversionList(rows, cancellingRelPath = null) {
  /** @type {Map<ConversionStatus, ConversionListRow[]>} */
  const groups = new Map(GROUP_ORDER.map((status) => [status, []]));
  for (const row of rows) {
    groups.get(deriveConversionStatus(row))?.push(row);
  }
  /** @type {ConversionListRow[]} */
  const ordered = [];
  for (const status of GROUP_ORDER) {
    const rowsInGroup = /** @type {ConversionListRow[]} */ (groups.get(status));
    rowsInGroup.sort((a, b) => sortKey(a, status) - sortKey(b, status));
    ordered.push(...rowsInGroup);
  }
  return ordered.map((row) => buildConversionEntry(row, cancellingRelPath));
}

/**
 * Builds the `GET /api/conversions?ids=` listing: one entry per requested id
 * that is present in `library_items`, in the request's own order (not id
 * order) — `rows` (`listConversionRowsForIds`, ordered by `li.id`) carries no
 * request-order information, so the reordering happens here. An id absent
 * from `rows` (never in `library_items`) is omitted.
 * @param {ConversionListRow[]} rows
 * @param {number[]} ids the parsed, deduplicated `ids` query, in request order
 * @param {string | null} [cancellingRelPath] `queue.cancellingRelPath()`
 * @returns {ConversionEntry[]}
 */
export function buildConversionEntriesForIds(rows, ids, cancellingRelPath = null) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const entries = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) entries.push(buildConversionEntry(row, cancellingRelPath));
  }
  return entries;
}

/**
 * Parses the `GET /api/conversions?ids=` query: a comma list of 1-500 ids,
 * each matching {@link ID_TOKEN_RE} and a safe integer (the media route's
 * `:id` syntax), duplicates ignored (first occurrence kept, in order).
 * @param {string} raw raw `ids` query value
 * @returns {number[] | null} the ids in request order, or `null` when invalid
 *   (no tokens, more than {@link MAX_IDS}, or any token failing the syntax or
 *   safe-integer check)
 */
export function parseConversionIds(raw) {
  const tokens = raw.split(',');
  if (tokens.length > MAX_IDS) return null;
  /** @type {number[]} */
  const ids = [];
  /** @type {Set<number>} */
  const seen = new Set();
  for (const token of tokens) {
    if (!ID_TOKEN_RE.test(token)) return null;
    const id = Number(token);
    if (!Number.isSafeInteger(id)) return null;
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}
