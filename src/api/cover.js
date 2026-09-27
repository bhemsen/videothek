// @ts-check

/**
 * `GET /media/:id/cover`: serves the resolved cover (folder image or
 * embedded picture slice) of a music/audiobooks item through Phase 3's
 * `sendMedia` — this module holds no streaming code of its own. Pure
 * orchestration: the lookup itself lives in `src/library/cover.js`.
 *
 * @see docs/specs/spec-music-audiobooks.md — "Cover route", "Embedded cover
 * slices".
 */

import { getAudioRow } from '../db/audio-meta-repo.js';
import { requireUser } from '../http/guards.js';
import { sendError } from '../http/respond.js';
import { sendMedia } from '../http/stream.js';
import { findCover } from '../library/cover.js';
import { readPictureRef } from '../library/tags/index.js';
import { resolveMediaPath } from '../media/paths.js';

/** `id` path param: 1-16 digits, no leading zero (also enforced to be a safe integer below). */
const ID_RE = /^[1-9][0-9]{0,15}$/;

/** Long-lived, per-user cache header (D10: cover route owned by P5, cache header via `sendMedia`'s `cacheControl`). */
const COVER_CACHE_CONTROL = 'private, max-age=86400';

/**
 * @typedef {import('../app.js').AppDeps & {
 *   readPicture?: typeof readPictureRef,
 * }} CoverDeps - `readPicture` is the optional test seam (default:
 *   {@link readPictureRef}); forwarded to `findCover`.
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
 * Sends the fixed `404 {"error":"not_found"}` every failed pre-check answers.
 * @param {import('node:http').ServerResponse} res
 * @returns {undefined}
 */
function notFound(res) {
  sendError(res, 404, 'not_found');
  return undefined;
}

/**
 * Logs `cover_stream_error { id, code }` for a `sendMedia` result whose
 * `error` is worth attention (any code other than the expected-miss trio
 * `ENOENT`/`ENOTDIR`/`EISDIR`, already surfaced as a plain `404`); an
 * ordinary miss or a client abort (`error: null`) is never logged.
 * @param {CoverDeps} deps
 * @param {number} id
 * @param {Error | null} error
 * @returns {void}
 */
function logStreamErrorIfNeeded(deps, id, error) {
  if (!error) return;
  const code = /** @type {NodeJS.ErrnoException} */ (error).code;
  if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return;
  deps.log.error('cover_stream_error', { id, code: code ?? null });
}

/**
 * Hands a resolved {@link import('../library/cover.js').CoverResult} to
 * `sendMedia`: a folder image streams as the whole entity, an embedded
 * picture streams as a `slice` of its source audio file.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('../library/cover.js').CoverResult} cover
 * @returns {ReturnType<typeof sendMedia>}
 */
function streamCover(req, res, cover) {
  if (cover.kind === 'file') {
    return sendMedia(req, res, { path: cover.path, cacheControl: COVER_CACHE_CONTROL });
  }
  return sendMedia(req, res, {
    path: cover.path,
    contentType: cover.mime,
    cacheControl: COVER_CACHE_CONTROL,
    slice: { offset: cover.offset, length: cover.length },
  });
}

/**
 * Handles `GET`/`HEAD /media/:id/cover`: id parsing, resolving the item to a
 * joined `music`/`audiobooks` row (with its `audio_meta`), the cover lookup,
 * then streaming it. Any failed pre-check or a missing cover answers `404
 * not_found`; covers of non-playable items are served too.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('../http/router.js').RequestContext} ctx
 * @param {CoverDeps} deps
 * @returns {Promise<void>}
 */
async function handleCover(req, res, ctx, deps) {
  const id = parseItemId(ctx.params.id);
  if (id === null) return notFound(res);

  const row = getAudioRow(deps.db, id);
  if (!row) return notFound(res);

  const cover = await findCover({
    mediaRoot: deps.config.mediaRoot,
    row,
    resolvePath: resolveMediaPath,
    readPicture: deps.readPicture ?? readPictureRef,
  });
  if (!cover) return notFound(res);

  const result = await streamCover(req, res, cover);
  logStreamErrorIfNeeded(deps, id, result.error);
}

/**
 * Registers `GET /media/:id/cover` (wrapped in `requireUser`; unauthenticated
 * -> `401 {"error":"unauthorized"}`). `HEAD` is served by the router's
 * automatic `GET` fallback.
 * @param {ReturnType<typeof import('../http/router.js').createRouter>} router
 * @param {CoverDeps} deps
 * @returns {void}
 */
export function registerCoverRoutes(router, deps) {
  router.add('GET', '/media/:id/cover', requireUser((req, res, ctx) => handleCover(req, res, ctx, deps)));
}
