// @ts-check

/**
 * `GET /media/:id/thumb`: serves the EXIF IFD1 JPEG thumbnail byte window of
 * an `images` item. Pure orchestration — every file-format fact (the JPEG
 * SOI check, the thumbnail pre-check, `THUMB_MIME`) lives in
 * `src/library/tags/exif.js`; this module holds no MIME literal and does no
 * byte inspection of its own.
 *
 * @see docs/specs/spec-image-gallery.md — "Thumbnail route".
 */

import { getThumbSource } from '../db/image-meta.js';
import { requireUser } from '../http/guards.js';
import { sendError } from '../http/respond.js';
import { sendMedia } from '../http/stream.js';
import { THUMB_MIME, verifyThumb } from '../library/tags/exif.js';
import { resolveMediaPath } from '../media/paths.js';

/** `id` path param: 1-16 digits, no leading zero (also enforced to be a safe integer below). */
const ID_RE = /^[1-9][0-9]{0,15}$/;

/** Long-lived cache header for a versioned thumbnail URL (`?v=<mtime>`, ignored server-side). */
const THUMB_CACHE_CONTROL = 'private, max-age=31536000, immutable';

/**
 * @typedef {import('../app.js').AppDeps & {
 *   openFile?: (path: string) => Promise<import('node:fs/promises').FileHandle>,
 * }} ThumbDeps - `openFile` is the optional test seam (absent in production);
 *   forwarded to both `verifyThumb` and `sendMedia`.
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
 * Handles one `GET`/`HEAD /media/:id/thumb` request: id parsing, every
 * pre-check in spec order, then handing the verified byte slice to
 * `sendMedia`. Each pre-check failure answers `404` without inspecting the
 * file further.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('../http/router.js').RequestContext} ctx
 * @param {ThumbDeps} deps
 * @returns {Promise<void>}
 */
async function handleThumb(req, res, ctx, deps) {
  const id = parseItemId(ctx.params.id);
  if (id === null) return notFound(res);

  const source = getThumbSource(deps.db, id);
  if (
    source === null ||
    source.category !== 'images' ||
    source.kind !== 'image' ||
    !source.playable ||
    source.thumbOffset === null ||
    source.thumbLength === null ||
    source.sourceSize === null ||
    source.sourceMtimeMs === null
  ) {
    return notFound(res);
  }

  const path = await resolveMediaPath(deps.config.mediaRoot, source.relPath);
  if (path === null) return notFound(res);

  const verified = await verifyThumb(
    path,
    { thumbOffset: source.thumbOffset, sourceSize: source.sourceSize, sourceMtimeMs: source.sourceMtimeMs },
    { openFile: deps.openFile }
  );
  if (!verified) return notFound(res);

  await sendMedia(req, res, {
    path,
    contentType: THUMB_MIME,
    cacheControl: THUMB_CACHE_CONTROL,
    slice: { offset: source.thumbOffset, length: source.thumbLength },
    openFile: deps.openFile,
  });
}

/**
 * Registers `GET /media/:id/thumb` (wrapped in `requireUser`; unauthenticated
 * -> `401 {"error":"unauthorized"}`). `HEAD` is served by the router's
 * automatic `GET` fallback. See {@link handleThumb} for the pre-check order.
 * @param {ReturnType<typeof import('../http/router.js').createRouter>} router
 * @param {ThumbDeps} deps
 * @returns {void}
 */
export function registerThumbRoutes(router, deps) {
  router.add('GET', '/media/:id/thumb', requireUser((req, res, ctx) => handleThumb(req, res, ctx, deps)));
}
