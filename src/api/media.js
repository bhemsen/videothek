// @ts-check

/**
 * `GET /media/:id` and `GET /media/:id/subtitles/:n`: authenticated,
 * range-capable streaming of any playable library item and its `.vtt`
 * subtitle sidecars. Pure orchestration — every file-format fact (the
 * `Content-Type`, the subtitle sidecar rules) lives in `src/http/stream.js`
 * (via `src/http/media-types.js`) and `src/media/subtitles.js`; this module
 * holds no MIME literal of its own beyond the imported subtitle constant.
 * `/media/:id` transparently prefers a fresh converted copy under
 * `CONVERT_DIR` over the original (`src/db/conversions.js`'s
 * `getFreshConversion`); subtitle sidecars always come from the source.
 *
 * @see docs/specs/spec-video-streaming.md — "Error bodies", "Subtitle route".
 * @see docs/specs/archive/spec-conversion-core.md — "Serving".
 */

import { getFreshConversion } from '../db/conversions.js';
import { getItemById } from '../db/library-queries.js';
import { requireUser } from '../http/guards.js';
import { sendError } from '../http/respond.js';
import { sendMedia } from '../http/stream.js';
import { resolveMediaPath } from '../media/paths.js';
import { listSubtitles, SUBTITLE_CONTENT_TYPE } from '../media/subtitles.js';

/** `id` path param: 1-16 digits, no leading zero (also enforced to be a safe integer below). */
const ID_RE = /^[1-9][0-9]{0,15}$/;

/** `n` (subtitle index) path param: `0`, or 1-3 digits with no leading zero. */
const SUBTITLE_INDEX_RE = /^(0|[1-9][0-9]{0,2})$/;

/**
 * @typedef {import('../app.js').AppDeps} MediaDeps
 */

/**
 * Parses the `:id` path param: must match {@link ID_RE} and be a safe
 * integer (rejects e.g. a 17-digit string that would parse but overflow).
 * @param {string} raw
 * @returns {number | null}
 */
function parseItemId(raw) {
  if (!ID_RE.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

/**
 * Parses the `:n` (subtitle index) path param per {@link SUBTITLE_INDEX_RE}.
 * @param {string} raw
 * @returns {number | null}
 */
function parseSubtitleIndex(raw) {
  return SUBTITLE_INDEX_RE.test(raw) ? Number(raw) : null;
}

/**
 * Sends the fixed `404 {"error":"not_found"}` every failed pre-check answers.
 * @param {import('node:http').ServerResponse} res
 * @returns {undefined}
 */
function notFound(res) {
  sendError(res, 404, 'not_found');
  return undefined;
}

/**
 * Logs `media_stream_error { id, code }` for a `sendMedia` result whose
 * `error` is worth attention (any code other than the expected-miss trio
 * `ENOENT`/`ENOTDIR`/`EISDIR`, already surfaced as a plain `404`); an
 * ordinary miss or a client abort (`error: null`) is never logged.
 * @param {MediaDeps} deps
 * @param {number} id
 * @param {Error | null} error
 * @returns {void}
 */
function logStreamErrorIfNeeded(deps, id, error) {
  if (!error) return;
  const code = /** @type {NodeJS.ErrnoException} */ (error).code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return;
  deps.log.error('media_stream_error', { id, code: code ?? null });
}

/**
 * Resolves the absolute path to actually stream for a playable item: a
 * fresh converted copy under `CONVERT_DIR` when `getFreshConversion` finds
 * one (status `playable`, source stat still matching), otherwise the
 * original under `MEDIA_ROOT` as before. `config.convertDir` is never read
 * for an item with no fresh conversion. A fresh row whose `output_rel` is
 * missing or no longer resolves inside `CONVERT_DIR` (file removed, or
 * tampered to escape it) yields `null` — never a fallback to the source,
 * which may not be browser-playable.
 * @param {MediaDeps} deps
 * @param {import('../db/library-repo.js').LibraryItemRow} row
 * @returns {Promise<string | null>}
 */
async function resolvePlaybackPath(deps, row) {
  const conversion = getFreshConversion(deps.db, row);
  if (conversion) {
    return resolveMediaPath(deps.config.convertDir, conversion.output_rel ?? '');
  }
  return resolveMediaPath(deps.config.mediaRoot, row.rel_path);
}

/**
 * Handles `GET`/`HEAD /media/:id`: streams any playable library item of any
 * category — a fresh converted copy under `CONVERT_DIR` when one exists
 * (see {@link resolvePlaybackPath}), otherwise the original. Unknown id, an
 * item whose file no longer resolves inside its root, or a category
 * unrelated pre-check failure all answer the same `404 not_found`; a known
 * but non-playable item answers `404 not_playable`. The query string is
 * never read.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('../http/router.js').RequestContext} ctx
 * @param {MediaDeps} deps
 * @returns {Promise<void>}
 */
async function handleMedia(req, res, ctx, deps) {
  const id = parseItemId(ctx.params.id);
  if (id === null) return notFound(res);

  const row = getItemById(deps.db, id);
  if (!row) return notFound(res);
  if (!row.playable) {
    sendError(res, 404, 'not_playable');
    return;
  }

  const filePath = await resolvePlaybackPath(deps, row);
  if (filePath === null) return notFound(res);

  const result = await sendMedia(req, res, { path: filePath });
  logStreamErrorIfNeeded(deps, id, result.error);
}

/**
 * Handles `GET`/`HEAD /media/:id/subtitles/:n`: streams the `n`-th `.vtt`
 * sidecar of a video item, discovered fresh on every request by
 * `listSubtitles`. The item need not be playable. An out-of-range `n` (which
 * is always the case for a non-video item, since `listSubtitles` returns
 * `[]` for those) answers `404 not_found`, same as an unknown id.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('../http/router.js').RequestContext} ctx
 * @param {MediaDeps} deps
 * @returns {Promise<void>}
 */
async function handleSubtitle(req, res, ctx, deps) {
  const id = parseItemId(ctx.params.id);
  const n = parseSubtitleIndex(ctx.params.n);
  if (id === null || n === null) return notFound(res);

  const row = getItemById(deps.db, id);
  if (!row) return notFound(res);

  const tracks = await listSubtitles(deps.config.mediaRoot, row);
  if (n >= tracks.length) return notFound(res);

  const result = await sendMedia(req, res, { path: tracks[n].path, contentType: SUBTITLE_CONTENT_TYPE });
  logStreamErrorIfNeeded(deps, id, result.error);
}

/**
 * Registers `GET /media/:id` and `GET /media/:id/subtitles/:n` (both wrapped
 * in `requireUser`; unauthenticated -> `401 {"error":"unauthorized"}`, no
 * bytes served). `HEAD` is served by the router's automatic `GET` fallback;
 * any other method on either path answers `405` with `Allow`.
 * @param {ReturnType<typeof import('../http/router.js').createRouter>} router
 * @param {MediaDeps} deps
 * @returns {void}
 */
export function registerMediaRoutes(router, deps) {
  router.add('GET', '/media/:id', requireUser((req, res, ctx) => handleMedia(req, res, ctx, deps)));
  router.add('GET', '/media/:id/subtitles/:n', requireUser((req, res, ctx) => handleSubtitle(req, res, ctx, deps)));
}
