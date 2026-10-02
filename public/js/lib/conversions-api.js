// @ts-check

/**
 * Conversions API client (`GET`/`POST /api/conversions`), thin wrappers over
 * P1's `request`. Response types mirror the server's
 * `src/api/conversion-json.js` shapes and are redeclared here since
 * `public/` never imports `src/` — see
 * docs/specs/archive/spec-conversion-core.md "API contract".
 */
import { request } from './api.js';

/** @typedef {import('./library-api.js').LibraryItem} LibraryItem */

/** @typedef {'none' | 'queued' | 'converting' | 'playable' | 'stale' | 'failed'} ConversionStatus */
/** @typedef {'web' | 'flac' | 'opus'} ConversionTarget */

/**
 * @typedef {object} ConversionEntry
 * @property {number} itemId
 * @property {LibraryItem} item
 * @property {boolean} convertible
 * @property {ConversionTarget | null} target
 * @property {ConversionStatus} status
 * @property {number | null} position - 1-based FIFO position among waiting `queued` items, else `null`.
 * @property {string | null} error - failure code (see conversion-format.js), `null` unless `status` is `failed`.
 * @property {string | null} errorDetail
 * @property {string[]} notes
 * @property {number | null} outputSize
 * @property {string | null} queuedAt - ISO-8601, or `null`.
 * @property {string | null} startedAt - ISO-8601, or `null`.
 * @property {string | null} finishedAt - ISO-8601, or `null`.
 */

/** @typedef {{ bytes: number, count: number, freeBytes: number | null }} ConversionUsage */

/**
 * @typedef {object} ConversionsEnvelope
 * @property {boolean} enabled - whether `CONVERTER_CMD` is configured.
 * @property {ConversionUsage} usage
 * @property {ConversionEntry[]} items
 */

/**
 * Builds the `ids` query value: one comma-joined value per given id, in
 * order (duplicates and syntax are the server's job to reject).
 * @param {readonly (number | string)[]} ids
 * @returns {string}
 */
function idsQuery(ids) {
  return ids.map((id) => encodeURIComponent(String(id))).join(',');
}

/**
 * Fetches `GET /api/conversions`. With `ids` given (even an empty array),
 * the server answers one entry per requested id, in request order
 * (`status: 'none'` for an id with no conversion row; an id absent from the
 * library is omitted; an empty list is rejected as `400 invalid_query`).
 * Without `ids`, every visible row comes back grouped by status.
 * @param {{ ids?: readonly (number | string)[] }} [opts]
 * @returns {Promise<ConversionsEnvelope>}
 */
export async function listConversions(opts = {}) {
  const { ids } = opts;
  const query = ids === undefined ? '' : `?ids=${idsQuery(ids)}`;
  const { data } = await request('GET', `/api/conversions${query}`);
  return /** @type {ConversionsEnvelope} */ (data);
}

/**
 * `POST /api/conversions/:id`: enqueues a conversion — a first request, a
 * retry of a `failed` row, or a re-conversion of a `stale` copy — and
 * resolves with the resulting entry (`202` newly queued, or `200` for an
 * already `queued`/`converting` item, unchanged and idempotent). Throws
 * `ApiError` (see `api.js`) for `404 not_found`, `503 conversion_disabled`,
 * `400 not_convertible`, `409 already_playable`, `401`, `403`.
 * @param {number | string} itemId
 * @returns {Promise<ConversionEntry>}
 */
export async function requestConversion(itemId) {
  const { data } = await request('POST', `/api/conversions/${encodeURIComponent(String(itemId))}`);
  return /** @type {ConversionEntry} */ (data);
}
