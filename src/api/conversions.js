// @ts-check

/**
 * Admin-only conversion routes: `GET /api/conversions` (listing + usage) and
 * `POST /api/conversions/:id` (enqueue, idempotent claim, retry/re-convert),
 * both wrapped in `requireAdmin`. Pure orchestration — entry/list JSON and
 * `ids` query parsing live in `conversion-json.js`; the SQL lives in
 * `src/db/conversions.js` / `src/db/conversion-queries.js`; the
 * target/convertible rules live in `src/convert/targets.js`. `deps.db`,
 * `deps.config` and `deps.now` are read only inside the handlers below, at
 * request time — never at `registerConversionRoutes` call time — so
 * `test/http/routes.test.js` (which calls `registerRoutes` with only
 * `{ db }`) stays green.
 * @see docs/specs/archive/spec-conversion-core.md — "API contract".
 */

import { statfs } from 'node:fs/promises';
import {
  buildConversionEntriesForIds,
  buildConversionEntry,
  buildConversionList,
  parseConversionIds,
} from './conversion-json.js';
import { storageKey, targetFor } from '../convert/targets.js';
import { enqueueConversion, getConversion, getConversionUsage } from '../db/conversions.js';
import { listConversionRows, listConversionRowsForIds } from '../db/conversion-queries.js';
import { getItemById } from '../db/library-queries.js';
import { requireAdmin } from '../http/guards.js';
import { sendError, sendJson } from '../http/respond.js';

/** `:id` path param: 1-16 digits, no leading zero (the media route's own rule). */
const ID_RE = /^[1-9][0-9]{0,15}$/;

/** @typedef {import('../app.js').AppDeps} ConversionDeps */

/**
 * Parses the `:id` path param: must match {@link ID_RE} and be a safe
 * integer.
 * @param {string} raw
 * @returns {number | null}
 */
function parseItemId(raw) {
  if (!ID_RE.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Free bytes on the filesystem holding `convertDir` (`bavail × bsize`),
 * display only. `null` when `convertDir` does not exist yet (e.g. before the
 * queue's first `start()`) or `statfs` otherwise fails.
 * @param {string} convertDir
 * @returns {Promise<number | null>}
 */
async function getFreeBytes(convertDir) {
  try {
    const stat = await statfs(convertDir);
    return stat.bavail * stat.bsize;
  } catch {
    return null;
  }
}

/**
 * `GET /api/conversions`: every conversion row grouped and ordered
 * (`conversion-json.js`'s `buildConversionList`) when `ids` is absent, or
 * one entry per requested id (present in `library_items`, in request order)
 * when it is present. `400 invalid_query` for an empty, malformed or
 * over-500 `ids`.
 * @param {ConversionDeps} deps
 * @param {import('node:http').ServerResponse} res
 * @param {import('../http/router.js').RequestContext} ctx
 * @returns {Promise<void>}
 */
async function handleList(deps, res, ctx) {
  const rawIds = ctx.url.searchParams.get('ids');
  let items;
  if (rawIds === null) {
    items = buildConversionList(listConversionRows(deps.db));
  } else {
    const ids = parseConversionIds(rawIds);
    if (ids === null) {
      sendError(res, 400, 'invalid_query');
      return;
    }
    items = buildConversionEntriesForIds(listConversionRowsForIds(deps.db, ids), ids);
  }
  const usage = getConversionUsage(deps.db);
  const freeBytes = await getFreeBytes(deps.config.convertDir);
  sendJson(res, 200, { enabled: Boolean(deps.conversions), usage: { ...usage, freeBytes }, items });
}

/**
 * The joined entry JSON for `id`, which the caller guarantees is present in
 * `library_items` (it already resolved `id` via `getItemById`).
 * @param {ConversionDeps} deps
 * @param {number} id
 * @returns {import('./conversion-json.js').ConversionEntry}
 */
function loadEntry(deps, id) {
  const [row] = listConversionRowsForIds(deps.db, [id]);
  return buildConversionEntry(row);
}

/**
 * `POST /api/conversions/:id`: enqueues a conversion — a first request, a
 * retry of a `failed` row, or a re-conversion of a `stale` copy — and
 * answers `202` with the freshly built entry (kicked synchronously before
 * that build, so an idle queue's entry already reports `converting`). An
 * already `queued`/`converting` row is left untouched and answered `200`
 * with its current entry (idempotent double `POST`). See the spec's "POST
 * order" for the exact precondition sequence this follows.
 * @param {ConversionDeps} deps
 * @param {import('node:http').ServerResponse} res
 * @param {import('../http/router.js').RequestContext} ctx
 * @returns {void}
 */
function handleEnqueue(deps, res, ctx) {
  const id = parseItemId(ctx.params.id);
  if (id === null) {
    sendError(res, 404, 'not_found');
    return;
  }
  const row = getItemById(deps.db, id);
  if (!row) {
    sendError(res, 404, 'not_found');
    return;
  }
  if (!deps.conversions) {
    sendError(res, 503, 'conversion_disabled');
    return;
  }
  const target = targetFor(row);
  if (target === null || row.size === 0) {
    sendError(res, 400, 'not_convertible');
    return;
  }
  if (row.playable) {
    sendError(res, 409, 'already_playable');
    return;
  }
  const existing = getConversion(deps.db, row.rel_path);
  if (existing && (existing.status === 'queued' || existing.status === 'converting')) {
    sendJson(res, 200, loadEntry(deps, id));
    return;
  }
  enqueueConversion(deps.db, {
    relPath: row.rel_path,
    storageKey: storageKey(row.rel_path),
    target,
    sourceSize: row.size,
    sourceMtimeMs: row.mtime_ms,
    now: deps.now(),
  });
  deps.conversions.kick();
  sendJson(res, 202, loadEntry(deps, id));
}

/**
 * Registers `GET /api/conversions` and `POST /api/conversions/:id`, both
 * wrapped in `requireAdmin` (`401 unauthorized` without a session, `403
 * forbidden` for role `user`).
 * @param {ReturnType<typeof import('../http/router.js').createRouter>} router
 * @param {ConversionDeps} deps
 * @returns {void}
 */
export function registerConversionRoutes(router, deps) {
  router.add('GET', '/api/conversions', requireAdmin((_req, res, ctx) => handleList(deps, res, ctx)));
  router.add('POST', '/api/conversions/:id', requireAdmin((_req, res, ctx) => handleEnqueue(deps, res, ctx)));
}
