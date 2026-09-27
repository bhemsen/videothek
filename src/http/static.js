import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { redirect } from './respond.js';
import { safeNext } from './security.js';

/** @typedef {import('./router.js').RequestContext} RequestContext */
/** @typedef {{ error: (event: string, fields?: Record<string, unknown>) => void }} StaticLog */

const PAGE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/** @type {Record<string, string>} */
const ASSET_CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Percent-decodes a request pathname as one whole string — never per
 * segment, since decoding only after splitting would miss a `%2F` that
 * reveals a hidden traversal segment once decoded. `null` for malformed
 * encoding.
 * @param {string} pathname
 * @returns {string | null}
 */
function decodePathname(pathname) {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/**
 * Rejects a decoded path carrying a NUL byte, a backslash (a path separator
 * on Windows, where this server also runs in development), or any segment
 * starting with `.` — covers `.`/`..` and hidden files/directories alike. A
 * valid page name or asset extension never triggers this (neither contains
 * those characters), so it never rejects a legitimate request.
 * @param {string} decoded
 * @returns {boolean}
 */
function isUnsafePath(decoded) {
  if (decoded.includes('\u0000') || decoded.includes('\\')) return true;
  return decoded.split('/').some((segment) => segment.startsWith('.'));
}

/**
 * Resolves a decoded, already safety-checked pathname inside `root`,
 * verifying containment so the result can never escape it.
 * @param {string} root
 * @param {string} decoded
 * @returns {string | null}
 */
function resolveInsideRoot(root, decoded) {
  const resolved = path.resolve(path.join(root, decoded));
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

/**
 * @param {string} filePath
 * @returns {Promise<import('node:fs').Stats | null>}
 */
async function statFile(filePath) {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

/**
 * Writes `headers` plus `status`, then, for `GET`, streams `filePath` as the
 * body; a `HEAD` request gets headers only (Node also drops any body it did
 * see for HEAD, but skipping the read here avoids opening the file at all).
 * Uses `pipeline` (not `.pipe()`) so a client aborting mid-transfer — or any
 * other stream error — destroys the source `fs.ReadStream` and its fd
 * instead of leaking it, and so this promise always settles. Once headers
 * are sent, a failure can no longer become a thrown `HttpError`, so it is
 * logged here as `request_error {method, path, stack}` and the socket is
 * destroyed — except `ERR_STREAM_PREMATURE_CLOSE` (client gone during/after
 * a fully-delivered response), which `src/http/stream.js` also treats as a
 * non-failure: still destroyed, just not logged.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} filePath
 * @param {number} status
 * @param {Record<string, string>} headers
 * @param {StaticLog} log
 * @param {string} urlPath
 * @param {(filePath: string) => import('node:stream').Readable} [openReadStream] -
 *   Test seam (default `fs.createReadStream`) for observing fd release.
 * @returns {Promise<void>}
 */
async function sendFile(req, res, filePath, status, headers, log, urlPath, openReadStream = createReadStream) {
  res.writeHead(status, headers);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  try {
    await pipeline(openReadStream(filePath), res);
  } catch (err) {
    const code = err instanceof Error ? /** @type {NodeJS.ErrnoException} */ (err).code : undefined;
    if (code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      log.error('request_error', {
        method: req.method,
        path: urlPath,
        stack: /** @type {Error} */ (err).stack,
      });
    }
    res.destroy();
  }
}

/**
 * Sends the 404 response: the real `public/404.html` when present (streamed
 * like any other page), otherwise a plain German fallback line. Exported so
 * `app.js`'s dispatch can reuse it for the "other -> 404 page" branch once
 * the static handler below reports `false` (nothing served) — `static.js`
 * itself no longer calls this for its own unmatched cases.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} root
 * @param {StaticLog} log
 * @param {string} urlPath
 * @returns {Promise<void>}
 */
export async function sendNotFoundPage(req, res, root, log, urlPath) {
  const filePath = path.join(root, '404.html');
  const info = await statFile(filePath);
  if (!info) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : 'Seite nicht gefunden.');
    return;
  }
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(info.size),
  };
  await sendFile(req, res, filePath, 404, headers, log, urlPath);
}

/**
 * Decides how an authenticated-page request for `name` (`null` for `/`) is
 * handled: `null` to serve it as-is, or a redirect location. `login` is
 * public and bounces an already-logged-in user to `safeNext(next)`; every
 * other page requires a session, and `admin` additionally requires the
 * admin role.
 * @param {string | null} name
 * @param {RequestContext} ctx
 * @returns {string | null}
 */
function resolveRedirect(name, ctx) {
  if (name === 'login') {
    return ctx.user ? safeNext(ctx.url.searchParams.get('next')) : null;
  }
  if (!ctx.user) {
    return `/login?next=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`;
  }
  if (name === 'admin' && ctx.user.role !== 'admin') {
    return '/';
  }
  return null;
}

/**
 * Serves `/` (`name === null`) or a single-segment `/<name>` page: applies
 * the page's session/admin rule, then streams the file with
 * `Cache-Control: no-store` (pages are session-dependent and never cached).
 * Resolves `false` when no matching page file exists, so the caller's
 * "nothing served" contract holds and the app's dispatch renders the 404
 * page (or, for a mismatched method on a registered route, `405`) instead.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {RequestContext} ctx
 * @param {string} root
 * @param {StaticLog} log
 * @param {string | null} name
 * @param {(filePath: string) => import('node:stream').Readable} [openReadStream] - See `sendFile`.
 * @returns {Promise<boolean>}
 */
async function servePage(req, res, ctx, root, log, name, openReadStream) {
  const filePath = path.join(root, `${name ?? 'index'}.html`);
  const info = await statFile(filePath);
  if (!info) return false;
  const location = resolveRedirect(name, ctx);
  if (location) {
    redirect(res, location);
    return true;
  }
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(info.size),
  };
  await sendFile(req, res, filePath, 200, headers, log, ctx.url.pathname, openReadStream);
  return true;
}

/**
 * `true` when the client's cached copy (`If-Modified-Since`, second
 * precision) is already at least as new as `mtimeMs`.
 * @param {import('node:http').IncomingMessage} req
 * @param {number} mtimeMs
 * @returns {boolean}
 */
function isNotModified(req, mtimeMs) {
  const header = req.headers['if-modified-since'];
  if (typeof header !== 'string') return false;
  const since = Date.parse(header);
  return !Number.isNaN(since) && since >= Math.floor(mtimeMs / 1000) * 1000;
}

/**
 * Serves a static asset by extension allowlist: containment-checked path,
 * `Cache-Control: no-cache` with `Last-Modified`, and a conditional `304`.
 * No session is required — assets are public. Resolves `false` when
 * `decoded` does not resolve to a file inside `root`, so the caller's
 * "nothing served" contract holds.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} root
 * @param {StaticLog} log
 * @param {string} decoded
 * @param {string} contentType
 * @param {string} urlPath
 * @param {(filePath: string) => import('node:stream').Readable} [openReadStream] - See `sendFile`.
 * @returns {Promise<boolean>}
 */
async function serveAsset(req, res, root, log, decoded, contentType, urlPath, openReadStream) {
  const resolved = resolveInsideRoot(root, decoded);
  const info = resolved ? await statFile(resolved) : null;
  if (!resolved || !info) return false;
  const lastModified = new Date(Math.floor(info.mtimeMs / 1000) * 1000).toUTCString();
  if (isNotModified(req, info.mtimeMs)) {
    res.writeHead(304, { 'Cache-Control': 'no-cache', 'Last-Modified': lastModified });
    res.end();
    return true;
  }
  const headers = {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache',
    'Last-Modified': lastModified,
    'Content-Length': String(info.size),
  };
  await sendFile(req, res, resolved, 200, headers, log, urlPath, openReadStream);
  return true;
}

/**
 * Creates the static/page handler. Serves `/` and single-segment `/<name>`
 * pages (session/admin/login rules, `Cache-Control: no-store`) and static
 * assets by extension allowlist (containment-checked, cached with
 * `Last-Modified`/`304`). Matches the module table's exact contract:
 * resolves `false` — nothing served — for a method other than `GET`/`HEAD`,
 * a decode failure or unsafe path, a well-formed `/<name>` with no matching
 * page file, `*.html`/`/index`/`/404`/an unknown extension, or an asset
 * that does not exist inside `publicDir`; `true` only once it has written a
 * response (200, 304 or a redirect). The app's own dispatch decides every
 * `false` case (`allow` -> `405`; else `/api/*` -> `404` JSON, other ->
 * `404` page via the exported `sendNotFoundPage`).
 * @param {{
 *   publicDir: string,
 *   log: StaticLog,
 *   openReadStream?: (filePath: string) => import('node:stream').Readable,
 * }} options `openReadStream` — test seam, see `sendFile`.
 * @returns {(
 *   req: import('node:http').IncomingMessage,
 *   res: import('node:http').ServerResponse,
 *   ctx: RequestContext,
 * ) => Promise<boolean>}
 */
export function createStaticHandler({ publicDir, log, openReadStream }) {
  const root = path.resolve(publicDir);
  return async (req, res, ctx) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    const decoded = decodePathname(ctx.url.pathname);
    if (decoded === null || isUnsafePath(decoded)) return false;
    if (decoded === '/') return servePage(req, res, ctx, root, log, null, openReadStream);

    const name = decoded.slice(1);
    if (PAGE_NAME_PATTERN.test(name) && name !== 'index' && name !== '404') {
      return servePage(req, res, ctx, root, log, name, openReadStream);
    }

    const contentType = ASSET_CONTENT_TYPES[path.extname(name).toLowerCase()];
    if (!contentType) return false;
    return serveAsset(req, res, root, log, decoded, contentType, ctx.url.pathname, openReadStream);
  };
}
