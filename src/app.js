/**
 * Assembles the HTTP app from the D4 server contract: router, session
 * resolution, the CSRF mutation guard, static/page serving and error
 * mapping. This module never listens — `src/server.js` and
 * `test/helpers/app.js` both call `listen()` on the returned `server`
 * themselves, so the full stack can run in-process on port 0 in tests.
 */

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSessionStore } from './auth/sessions.js';
import { parseCookies, serializeCookie } from './http/cookies.js';
import { HttpError, sendError } from './http/respond.js';
import { createRouter } from './http/router.js';
import { registerRoutes } from './http/routes.js';
import { applySecurityHeaders, isHttps, isSameOrigin } from './http/security.js';
import { createStaticHandler, sendNotFoundPage } from './http/static.js';

/** @typedef {import('node:http').IncomingMessage} IncomingMessage */
/** @typedef {import('node:http').ServerResponse} ServerResponse */
/** @typedef {import('./http/router.js').AuthUser} AuthUser */
/** @typedef {import('./config.js').Config} Config */
/** @typedef {import('./log.js').Logger} Logger */
/** @typedef {import('./library/index.js').LibraryService} LibraryService */
/** @typedef {import('./convert/queue.js').ConversionQueue} ConversionQueue */

/**
 * @typedef {{
 *   config: Config,
 *   db: import('node:sqlite').DatabaseSync,
 *   log: Logger,
 *   now: () => number,
 *   sessions: ReturnType<typeof createSessionStore>,
 *   library?: LibraryService,
 *   conversions?: ConversionQueue,
 * } & Record<string, unknown>} AppDeps
 */

const DEFAULT_PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SESSION_COOKIE = 'vt_session';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Resolves `ctx.user`/`ctx.sessionId` from the session cookie, sliding the
 * expiry (re-sending the cookie) when the store refreshed it, and clearing
 * an invalid/expired cookie. No cookie at all leaves the response untouched.
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {ReturnType<typeof createSessionStore>} sessions
 * @param {() => number} now
 * @returns {{ user: AuthUser | null, sessionId: string | null }}
 */
function resolveSession(req, res, sessions, now) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token === undefined) return { user: null, sessionId: null };

  const resolved = sessions.resolve(token);
  if (!resolved) {
    res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAge: 0, secure: isHttps(req) }));
    return { user: null, sessionId: null };
  }
  if (resolved.refreshedExpiresAt !== null) {
    const maxAge = Math.round((resolved.refreshedExpiresAt - now()) / 1000);
    res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, { maxAge, secure: isHttps(req) }));
  }
  return { user: resolved.user, sessionId: resolved.sessionId };
}

/**
 * The `Origin`/expected-host pair for the `origin_rejected` log line.
 * Duplicates security.js's own "first `X-Forwarded-Host` else `Host`"
 * lookup (private there) — kept local since `src/http/security.js` is
 * outside this issue's file list.
 * @param {IncomingMessage} req
 * @returns {{ origin: string | undefined, host: string | undefined }}
 */
function originLogFields(req) {
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? req.headers.host;
  return { origin: req.headers.origin, host };
}

/**
 * `true` when a thrown, non-`HttpError` failure must be reported as JSON
 * `{ "error": "internal" }` rather than the plain German fallback text —
 * every `/api/*` path, the JSON auth endpoints, and any non-GET/HEAD verb.
 * @param {string} pathname
 * @param {string} method
 * @returns {boolean}
 */
function isJsonErrorPath(pathname, method) {
  if (pathname.startsWith('/api/') || pathname === '/login' || pathname === '/logout') return true;
  return method !== 'GET' && method !== 'HEAD';
}

/**
 * Logs one `request_error {method, path, stack}` line for a non-`HttpError`
 * dispatch failure.
 * @param {Logger} log
 * @param {string} method
 * @param {URL} url
 * @param {unknown} err
 * @returns {void}
 */
function logRequestError(log, method, url, err) {
  log.error('request_error', {
    method,
    path: url.pathname,
    stack: err instanceof Error ? err.stack : String(err),
  });
}

/**
 * Maps a dispatch failure to a response: a thrown `HttpError` -> its own
 * status/code/headers; anything else -> `500` (JSON or plain text per
 * {@link isJsonErrorPath}) plus one `request_error` log line. Once headers
 * are already sent, no further response can be framed, so the socket is
 * destroyed instead of sending a response; a non-`HttpError` still gets its
 * `request_error` log line first, the same shape as the app's own top-level
 * dispatch error log (see `src/http/static.js` `sendFile`).
 * @param {unknown} err
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 * @param {Logger} log
 * @param {URL} url
 * @returns {void}
 */
function handleDispatchError(err, req, res, log, url) {
  const method = req.method ?? 'GET';
  if (res.headersSent) {
    if (!(err instanceof HttpError)) {
      logRequestError(log, method, url, err);
    }
    res.destroy();
    return;
  }
  if (err instanceof HttpError) {
    sendError(res, err.status, err.code, err.headers);
    return;
  }
  logRequestError(log, method, url, err);
  if (isJsonErrorPath(url.pathname, method)) {
    sendError(res, 500, 'internal');
    return;
  }
  res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(method === 'HEAD' ? undefined : 'Interner Fehler.');
}

/**
 * Builds the request listener implementing the fixed dispatch order:
 * security headers -> parse URL -> resolve session -> mutation guard ->
 * route match -> static fallback -> 405/404.
 * @param {AppDeps} deps
 * @param {ReturnType<typeof createRouter>} router
 * @param {ReturnType<typeof createStaticHandler>} staticHandler
 * @param {string} publicDir
 * @returns {(req: IncomingMessage, res: ServerResponse) => Promise<void>}
 */
function createRequestHandler(deps, router, staticHandler, publicDir) {
  return async (req, res) => {
    applySecurityHeaders(res);

    /** @type {URL} */
    let url;
    try {
      // Prepending the base (rather than passing it as the WHATWG URL
      // constructor's second, "base" argument) keeps a request-target
      // starting with `//` a plain pathname instead of being parsed as a
      // network-path reference — `new URL('//x', 'http://localhost')` would
      // otherwise turn `GET //healthz` into host `healthz`, pathname `/`.
      url = new URL(`http://localhost${req.url ?? '/'}`);
    } catch {
      sendError(res, 404, 'not_found');
      return;
    }

    const method = req.method ?? 'GET';

    try {
      const { user, sessionId } = resolveSession(req, res, deps.sessions, deps.now);

      if (MUTATING_METHODS.has(method) && !isSameOrigin(req)) {
        deps.log.warn('origin_rejected', originLogFields(req));
        sendError(res, 403, 'forbidden_origin');
        return;
      }

      const matched = router.match(method, url.pathname);
      const params = matched && 'handler' in matched ? matched.params : {};
      const ctx = { user, params, url, sessionId };

      if (matched && 'handler' in matched) {
        await matched.handler(req, res, ctx);
        return;
      }
      if ((method === 'GET' || method === 'HEAD') && !url.pathname.startsWith('/api/')) {
        if (await staticHandler(req, res, ctx)) return;
      }
      if (matched && 'allow' in matched) {
        sendError(res, 405, 'method_not_allowed', { Allow: matched.allow.join(', ') });
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        sendError(res, 404, 'not_found');
        return;
      }
      await sendNotFoundPage(req, res, publicDir, deps.log, url.pathname);
    } catch (err) {
      handleDispatchError(err, req, res, deps.log, url);
    }
  };
}

/**
 * Closes `server`, tolerating the case where it was never started
 * (`close()` before `listen()` rejects with "Server is not running").
 * @param {import('node:http').Server} server
 * @returns {Promise<void>}
 */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err && !/not running/i.test(err.message)) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

/**
 * @param {{
 *   config: Config,
 *   db: import('node:sqlite').DatabaseSync,
 *   log: Logger,
 *   now?: () => number,
 *   publicDir?: string,
 *   [key: string]: unknown,
 * }} options
 * @returns {{
 *   server: import('node:http').Server,
 *   deps: AppDeps,
 *   router: ReturnType<typeof createRouter>,
 *   close: () => Promise<void>,
 * }}
 */
export function createApp({ config, db, log, now = Date.now, publicDir = DEFAULT_PUBLIC_DIR, ...extra }) {
  const resolvedPublicDir = path.resolve(publicDir);
  const sessions = createSessionStore({ db, now });
  const deps = /** @type {AppDeps} */ ({ config, db, log, now, sessions, ...extra });

  const router = createRouter();
  registerRoutes(router, deps);
  const staticHandler = createStaticHandler({ publicDir: resolvedPublicDir, log });

  const server = http.createServer(createRequestHandler(deps, router, staticHandler, resolvedPublicDir));

  return { server, deps, router, close: () => closeServer(server) };
}
