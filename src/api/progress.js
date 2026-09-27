// @ts-check

import { requireUser } from '../http/guards.js';
import { readJson, sendError, sendJson, sendNoContent } from '../http/respond.js';
import { getItemById } from '../db/library-queries.js';
import { getNextEpisode } from '../db/episodes.js';
import {
  deleteProgress,
  getProgressRow,
  listContinueRows,
  listSeriesProgressRows,
  listStateRows,
  upsertProgress,
} from '../db/progress.js';
import { toItemJson } from './library-json.js';
import { computeNextUp } from './progress-next-up.js';
import {
  START_THRESHOLD_S,
  decideProgressWrite,
  deriveProgressState,
  parseProgressQuery,
  toProgressEntryJson,
  validateProgressBody,
} from './progress-rules.js';

/**
 * `GET/PUT/DELETE /api/progress/:id` and the collection `GET /api/progress`
 * (continue + state views). See the spec's "API contract" for the exact
 * processing order and query rules; this module is thin — every rule lives
 * in `progress-rules.js` / `progress-next-up.js` / `src/db/progress.js`.
 * @typedef {import('../db/library-repo.js').LibraryItemRow} LibraryItemRow
 * @typedef {{ position_seconds: number, duration_seconds: number, finished: 0 | 1, updated_at: number }} ProgressRowLike
 */

/** `:id` must be one to sixteen digits, no leading zero, and a safe integer (Phases 3/6's rule). */
const ID_PATTERN = /^[1-9][0-9]{0,15}$/;

/**
 * Parses and validates a route `:id` param.
 * @param {string} raw
 * @returns {number | null}
 */
function parseItemId(raw) {
  if (!ID_PATTERN.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * The authenticated user's id. `requireUser` guarantees `ctx.user` is set at
 * runtime before this handler ever runs; the cast makes that guarantee
 * explicit for `tsc --strict`, which cannot see across the wrapper.
 * @param {import('../http/router.js').RequestContext} ctx
 * @returns {number}
 */
function userId(ctx) {
  return /** @type {import('../http/router.js').AuthUser} */ (ctx.user).id;
}

/**
 * Resolves a route `:id` param to its full `library_items` row. `undefined`
 * for a malformed/unsafe id or one absent from the index — both map to the
 * same `404 not_found` at the call site (P2's `getItemById` convention:
 * result checked falsy, never `=== null`).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} raw
 * @returns {LibraryItemRow | undefined}
 */
function lookupItem(db, raw) {
  const id = parseItemId(raw);
  return id === null ? undefined : getItemById(db, id);
}

/**
 * Builds the entry JSON for a stored progress row (any of the three joined
 * row shapes this module reads — they all carry these four columns).
 * @param {number} itemId
 * @param {ProgressRowLike} row
 * @returns {import('./progress-rules.js').ProgressEntry}
 */
function entryFromProgressRow(itemId, row) {
  return toProgressEntryJson({
    itemId,
    position: row.position_seconds,
    duration: row.duration_seconds,
    finished: row.finished === 1,
    updatedAt: row.updated_at,
  });
}

/**
 * The display state of one `rel_path` for the current user — used by the
 * next-up computation's `getState` lookup (a bare "no row" counts as `none`,
 * same as `deriveProgressState` would derive from `position: 0`).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} uid
 * @param {string} relPath
 * @returns {'none' | 'in_progress' | 'finished'}
 */
function progressStateFor(db, uid, relPath) {
  const row = getProgressRow(db, uid, relPath);
  return row ? deriveProgressState({ finished: row.finished === 1, position: row.position_seconds }) : 'none';
}

/**
 * `GET /api/progress/:id` handler.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {import('../http/router.js').Handler}
 */
function createGetItemHandler(db) {
  return (_req, res, ctx) => {
    const item = lookupItem(db, ctx.params.id);
    if (!item) {
      sendError(res, 404, 'not_found');
      return;
    }
    const row = getProgressRow(db, userId(ctx), item.rel_path);
    const entry = row
      ? entryFromProgressRow(item.id, row)
      : toProgressEntryJson({ itemId: item.id, position: 0, duration: null, finished: false, updatedAt: null });
    sendJson(res, 200, entry);
  };
}

/**
 * `PUT /api/progress/:id` handler, in the spec's exact order: id syntax (404)
 * -> `readJson` (its 400/413/415, thrown as `HttpError`) -> item lookup (404)
 * -> resumable check -> missing/non-object body (`invalid_json`) -> field
 * validation (`invalid_progress`) -> write rule.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {() => number} now
 * @returns {import('../http/router.js').Handler}
 */
function createPutItemHandler(db, now) {
  return async (req, res, ctx) => {
    const id = parseItemId(ctx.params.id);
    if (id === null) {
      sendError(res, 404, 'not_found');
      return;
    }
    const body = await readJson(req);
    const item = getItemById(db, id);
    if (!item) {
      sendError(res, 404, 'not_found');
      return;
    }
    if (item.category === 'images' || !item.playable) {
      sendError(res, 400, 'not_resumable');
      return;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      sendError(res, 400, 'invalid_json');
      return;
    }
    const validated = validateProgressBody(body);
    if (validated === null) {
      sendError(res, 400, 'invalid_progress');
      return;
    }
    const uid = userId(ctx);
    const existing = getProgressRow(db, uid, item.rel_path);
    const decision = decideProgressWrite({
      category: item.category,
      position: validated.position,
      duration: validated.duration,
      existingFinished: existing ? existing.finished === 1 : false,
    });
    if (!decision.write) {
      // `decision.write` is only ever `false` when `existingFinished` was
      // `true`, which requires `existing` to be a real row.
      sendJson(res, 200, entryFromProgressRow(item.id, /** @type {ProgressRowLike} */ (existing)));
      return;
    }
    const stored = upsertProgress(db, {
      userId: uid,
      relPath: item.rel_path,
      positionSeconds: validated.position,
      durationSeconds: validated.duration,
      finished: decision.finished,
      updatedAt: now(),
    });
    sendJson(res, 200, entryFromProgressRow(item.id, stored));
  };
}

/**
 * `DELETE /api/progress/:id` handler — idempotent `204`, no resumable check.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {import('../http/router.js').Handler}
 */
function createDeleteItemHandler(db) {
  return (_req, res, ctx) => {
    const item = lookupItem(db, ctx.params.id);
    if (!item) {
      sendError(res, 404, 'not_found');
      return;
    }
    deleteProgress(db, userId(ctx), item.rel_path);
    sendNoContent(res);
  };
}

/**
 * The `all`-view items: every `in_progress`/`finished` row of present,
 * playable items of the requested categories, no `item`, no limit.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} uid
 * @param {import('../library/categories.js').Category[]} categories
 * @returns {import('./progress-rules.js').ProgressEntry[]}
 */
function buildStateItems(db, uid, categories) {
  const rows = listStateRows(db, { userId: uid, categories, startThreshold: START_THRESHOLD_S });
  return rows.map((row) => entryFromProgressRow(row.id, row));
}

/**
 * The `next_up` half of the continue view, as merge candidates carrying the
 * sort key (`updatedAtMs`/`itemId`) alongside the finished entry.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} uid
 * @returns {{ updatedAtMs: number, itemId: number, entry: object }[]}
 */
function buildNextUpCandidates(db, uid) {
  const seriesRows = listSeriesProgressRows(db, uid);
  const nextUp = computeNextUp(seriesRows, {
    getNext: (row) => getNextEpisode(db, row),
    getState: (relPath) => progressStateFor(db, uid, relPath),
  });
  return nextUp.map(({ row, updatedAt }) => ({
    updatedAtMs: updatedAt,
    itemId: row.id,
    entry: {
      itemId: row.id,
      position: 0,
      duration: null,
      state: /** @type {const} */ ('next_up'),
      updatedAt: new Date(updatedAt).toISOString(),
      item: toItemJson(row),
    },
  }));
}

/**
 * The `continue`-view items: the user's `in_progress` rows merged with
 * `next_up` entries (only when `series` was requested), ordered by
 * `updatedAt` desc then `itemId` desc, `limit` applied after the merge.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} uid
 * @param {import('../library/categories.js').Category[]} categories
 * @param {number} limit
 * @returns {object[]}
 */
function buildContinueEntries(db, uid, categories, limit) {
  const continueCandidates = listContinueRows(db, { userId: uid, categories, startThreshold: START_THRESHOLD_S, limit }).map(
    (row) => ({ updatedAtMs: row.updated_at, itemId: row.id, entry: { ...entryFromProgressRow(row.id, row), item: toItemJson(row) } })
  );
  const nextUpCandidates = categories.includes('series') ? buildNextUpCandidates(db, uid) : [];
  return [...continueCandidates, ...nextUpCandidates]
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs || b.itemId - a.itemId)
    .slice(0, limit)
    .map((candidate) => candidate.entry);
}

/**
 * `GET /api/progress` handler.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {import('../http/router.js').Handler}
 */
function createListHandler(db) {
  return (_req, res, ctx) => {
    const query = parseProgressQuery(ctx.url.searchParams);
    if (query === null) {
      sendError(res, 400, 'invalid_query');
      return;
    }
    const uid = userId(ctx);
    const items =
      query.view === 'all'
        ? buildStateItems(db, uid, query.categories)
        : buildContinueEntries(db, uid, query.categories, /** @type {number} */ (query.limit));
    sendJson(res, 200, { items });
  };
}

/**
 * Registers the per-item and collection progress routes, all behind
 * `requireUser`.
 * @param {ReturnType<typeof import('../http/router.js').createRouter>} router
 * @param {{ db: import('node:sqlite').DatabaseSync, now: () => number }} deps
 * @returns {void}
 */
export function registerProgressRoutes(router, { db, now }) {
  router.add('GET', '/api/progress/:id', requireUser(createGetItemHandler(db)));
  router.add('PUT', '/api/progress/:id', requireUser(createPutItemHandler(db, now)));
  router.add('DELETE', '/api/progress/:id', requireUser(createDeleteItemHandler(db)));
  router.add('GET', '/api/progress', requireUser(createListHandler(db)));
}
