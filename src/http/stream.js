// @ts-check

import { createReadStream } from 'node:fs';
import { open as fsOpen } from 'node:fs/promises';
import { extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { mediaTypeFor } from './media-types.js';
import { parseRange } from './range.js';
import { sendError } from './respond.js';

/**
 * @typedef {import('node:fs/promises').FileHandle} FileHandle
 * @typedef {import('node:fs').Stats} Stats
 */

/**
 * A byte window `[offset, offset + length)` of the file to serve as the
 * whole entity (P6's thumbnail route: an embedded image inside a larger file).
 * @typedef {{ offset: number, length: number }} MediaSlice
 */

/**
 * @typedef {object} SendMediaOptions
 * @property {string} path - Absolute path, already verified by the caller
 *   (`resolveMediaPath`) to lie inside `MEDIA_ROOT`; no containment check here.
 * @property {string} [contentType] - Overrides `mediaTypeFor(extname(path))`.
 * @property {string} [cacheControl] - Overrides `'private, no-cache'` (P5/P6
 *   pass a longer-lived value for covers/thumbs).
 * @property {number} [idleTimeoutMs] - Overrides `MEDIA_IDLE_TIMEOUT_MS`.
 * @property {MediaSlice} [slice] - A window past the end of the file is `404`.
 * @property {(path: string) => Promise<FileHandle>} [openFile] - Test seam;
 *   defaults to `fs.promises.open(path, 'r')`.
 */

/**
 * @typedef {object} SendMediaResult
 * @property {number} status - The HTTP status actually sent.
 * @property {boolean} aborted - `true` when the client disconnected, or the
 *   idle timeout fired, before the body finished sending.
 * @property {Error | null} error - Set for a failure worth a caller's
 *   attention (`.code` tells an ordinary miss — `ENOENT`/`ENOTDIR`/`EISDIR` —
 *   from an unusual one); `null` on every ordinary outcome, incl. 404/416
 *   and a client abort.
 */

/**
 * Idle timeout between two chunks flowing to the client (nginx `send_timeout`
 * precedent, docs/specs/spec-video-streaming.md "Idle timeout" decision): a
 * paused client (e.g. a sleeping device) never pins a file descriptor open
 * indefinitely.
 */
export const MEDIA_IDLE_TIMEOUT_MS = 60_000;

const DEFAULT_CACHE_CONTROL = 'private, no-cache';

/**
 * Streams a single already-guarded media file (or a byte slice of one) as an
 * HTTP response, honouring `Range` (`200`/`206`/`416`) and `HEAD`, with no
 * validators (`If-Range` is ignored and answered with a full `200`). The
 * file is opened and stat'd before any header is written, so a vanished
 * file, a permission error or a path that is actually a directory all
 * answer a clean `404`. The body, when there is one, is streamed with
 * `fs.createReadStream` (never read fully into memory) via `stream.pipeline`,
 * which closes the file handle through Node's own fd-aware teardown
 * (`autoClose`, default on); every path that creates no read stream (`HEAD`,
 * `416`, a `404` decided after open, an empty body) closes it explicitly
 * instead. See the "Streaming mechanics"/"Idle timeout" decisions in
 * docs/specs/spec-video-streaming.md. The caller (the router) is expected to
 * invoke this only for `GET`/`HEAD` (P1: `HEAD` runs the `GET` handler).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {SendMediaOptions} opts
 * @returns {Promise<SendMediaResult>} Settles once the response has finished
 *   or closed.
 */
export async function sendMedia(req, res, opts) {
  const {
    path,
    contentType = mediaTypeFor(extname(path)),
    cacheControl = DEFAULT_CACHE_CONTROL,
    idleTimeoutMs = MEDIA_IDLE_TIMEOUT_MS,
    slice,
    openFile = defaultOpenFile,
  } = opts;

  const opened = await openAndStat(openFile, path);
  if (!opened.handle) {
    sendError(res, 404, 'not_found');
    return { status: 404, aborted: false, error: opened.error };
  }
  const { handle, stat } = opened;

  const entity = resolveEntity(stat, slice);
  if (!entity) {
    await closeQuietly(handle);
    sendError(res, 404, 'not_found');
    return { status: 404, aborted: false, error: null };
  }

  const range = decideRange(req, entity.size);
  if (range.type === 'unsatisfiable') {
    await closeQuietly(handle);
    sendError(res, 416, 'range_not_satisfiable', { 'Content-Range': `bytes */${entity.size}` });
    return { status: 416, aborted: false, error: null };
  }

  const start = range.type === 'range' ? range.start : 0;
  const end = range.type === 'range' ? range.end : entity.size - 1;
  const status = range.type === 'range' ? 206 : 200;
  const headers = buildHeaders({ contentType, cacheControl, start, end, size: entity.size, status });

  if (req.method === 'HEAD' || end - start + 1 === 0) {
    res.writeHead(status, headers);
    res.end();
    await closeQuietly(handle);
    return { status, aborted: false, error: null };
  }

  res.writeHead(status, headers);
  const outcome = await streamBody({
    res,
    path,
    handle,
    start: entity.baseOffset + start,
    end: entity.baseOffset + end,
    idleTimeoutMs,
  });
  return { status, ...outcome };
}

/**
 * Default `openFile`: read-only, per the media root's read-only contract.
 * @param {string} path
 * @returns {Promise<FileHandle>}
 */
function defaultOpenFile(path) {
  return fsOpen(path, 'r');
}

/**
 * Opens the file and stats it. A thrown open/stat error is returned as-is —
 * the caller answers `404` either way, but keeps the error so a route can
 * tell an expected miss from an unusual one. A non-regular-file stat (a
 * directory) is normalized to a synthetic `EISDIR` error for the same
 * reason, since no read is ever attempted on it to raise one naturally.
 * @param {(path: string) => Promise<FileHandle>} openFile
 * @param {string} path
 * @returns {Promise<{ handle: FileHandle, stat: Stats, error?: undefined } |
 *   { handle: null, stat?: undefined, error: NodeJS.ErrnoException }>}
 */
async function openAndStat(openFile, path) {
  /** @type {FileHandle} */
  let handle;
  try {
    handle = await openFile(path);
  } catch (err) {
    return { handle: null, error: /** @type {NodeJS.ErrnoException} */ (err) };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await closeQuietly(handle);
      const err = /** @type {NodeJS.ErrnoException} */ (new Error(`EISDIR: not a file, read '${path}'`));
      err.code = 'EISDIR';
      return { handle: null, error: err };
    }
    return { handle, stat };
  } catch (err) {
    await closeQuietly(handle);
    return { handle: null, error: /** @type {NodeJS.ErrnoException} */ (err) };
  }
}

/**
 * Closes a file handle, swallowing any error — a close failure must never
 * mask the response already decided.
 * @param {FileHandle} handle
 * @returns {Promise<void>}
 */
async function closeQuietly(handle) {
  try {
    await handle.close();
  } catch {
    // best effort; nothing left to recover
  }
}

/**
 * Resolves the servable entity's byte window: the whole file, or — when
 * `slice` is given — the sub-window `[offset, offset + length)` of it.
 * @param {Stats} stat
 * @param {MediaSlice} [slice]
 * @returns {{ baseOffset: number, size: number } | null} `null` when the
 *   slice extends past the end of the file.
 */
function resolveEntity(stat, slice) {
  if (!slice) {
    return { baseOffset: 0, size: stat.size };
  }
  if (slice.offset + slice.length > stat.size) {
    return null;
  }
  return { baseOffset: slice.offset, size: slice.length };
}

/**
 * `HEAD` and any `If-Range` header ignore `Range` entirely (no validators
 * are issued, so `If-Range` can never match); otherwise the header is
 * parsed against the entity size.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} size
 * @returns {import('./range.js').RangeResult}
 */
function decideRange(req, size) {
  if (req.method === 'HEAD' || req.headers['if-range'] !== undefined) {
    return { type: 'none' };
  }
  const header = req.headers.range;
  return parseRange(typeof header === 'string' ? header : undefined, size);
}

/**
 * Builds the response headers for a `200` or `206` media response.
 * @param {{
 *   contentType: string,
 *   cacheControl: string,
 *   start: number,
 *   end: number,
 *   size: number,
 *   status: 200 | 206,
 * }} args
 * @returns {import('node:http').OutgoingHttpHeaders}
 */
function buildHeaders({ contentType, cacheControl, start, end, size, status }) {
  /** @type {import('node:http').OutgoingHttpHeaders} */
  const headers = {
    'Content-Type': contentType,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  };
  if (status === 206) {
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  return headers;
}

/**
 * Streams the body from `start` to `end` (inclusive, absolute file offsets)
 * into `res`, settling once the response has finished or closed. Arms a
 * re-armable, `unref`'ed idle timer that destroys the response — never the
 * socket's own keep-alive timeout — when no chunk has flowed for
 * `idleTimeoutMs`; that destruction, like a genuine client disconnect,
 * surfaces from `pipeline` as `ERR_STREAM_PREMATURE_CLOSE`. No explicit
 * handle close is needed here: passing it as `fd` makes Node's read-stream
 * teardown close it on every completion path (`autoClose`, default on).
 * @param {{
 *   res: import('node:http').ServerResponse,
 *   path: string,
 *   handle: FileHandle,
 *   start: number,
 *   end: number,
 *   idleTimeoutMs: number,
 * }} args
 * @returns {Promise<{ aborted: boolean, error: Error | null }>}
 */
async function streamBody({ res, path, handle, start, end, idleTimeoutMs }) {
  const readStream = createReadStream(path, { fd: handle, start, end });
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let idleTimer;
  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => res.destroy(), idleTimeoutMs).unref();
  };
  readStream.on('data', armIdleTimer);
  armIdleTimer();

  try {
    await pipeline(readStream, res);
    return { aborted: false, error: null };
  } catch (err) {
    const code = err instanceof Error ? /** @type {NodeJS.ErrnoException} */ (err).code : undefined;
    if (code === 'ERR_STREAM_PREMATURE_CLOSE') {
      return { aborted: true, error: null };
    }
    return { aborted: false, error: err instanceof Error ? err : new Error(String(err)) };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}
