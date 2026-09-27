/**
 * `POST /login`, `POST /logout` and `GET /api/me` — session-cookie
 * authentication with per-username login throttling and session-fixation
 * defence. Owns the process-wide login rate limiter instance.
 */

import { DUMMY_HASH, verifyPassword } from '../auth/password.js';
import { createLoginLimiter } from '../auth/rate-limit.js';
import { normalizeUsername, validatePassword, validateUsername } from '../auth/validation.js';
import { getUserByUsername } from '../db/users.js';
import { serializeCookie } from '../http/cookies.js';
import { requireUser } from '../http/guards.js';
import { readJson, sendError, sendJson, sendNoContent } from '../http/respond.js';
import { isHttps } from '../http/security.js';

const SESSION_COOKIE = 'vt_session';
const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 2592000, matches the 30-day idle session lifetime
// Caps the throttle key and the logged `user` value (in code points): valid
// usernames have at most 32, so a longer (up to 16 KiB) body value never
// becomes a huge Map key or log field, and a cut value stays invalid.
const MAX_USERNAME_KEY_LENGTH = 64;

/**
 * @param {import('node:http').IncomingMessage} req
 * @returns {string}
 */
function clientIp(req) {
  return req.socket.remoteAddress ?? '';
}

/**
 * `POST /login`'s required body shape: an object with string `username` and
 * `password` fields; anything else (incl. `undefined`, the no-body case)
 * counts as `invalid_json`.
 * @param {unknown} body
 * @returns {body is { username: string, password: string }}
 */
function isCredentialsBody(body) {
  const candidate = /** @type {{ username?: unknown, password?: unknown } | null} */ (body);
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    typeof candidate.username === 'string' &&
    typeof candidate.password === 'string'
  );
}

/**
 * Sets (or clears, with `token = ''` and `maxAge = 0`) the `vt_session`
 * cookie, `Secure` only when the connection is TLS or forwarded as such.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} token
 * @param {number} maxAge
 * @returns {void}
 */
function setSessionCookie(req, res, token, maxAge) {
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, { maxAge, secure: isHttps(req) }));
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('../http/router.js').RequestContext} ctx
 * @param {import('../app.js').AppDeps} deps
 * @param {ReturnType<typeof createLoginLimiter>} limiter
 * @returns {Promise<void>}
 */
async function handleLogin(req, res, ctx, deps, limiter) {
  const body = await readJson(req);
  if (!isCredentialsBody(body)) {
    sendError(res, 400, 'invalid_json');
    return;
  }

  const username = [...normalizeUsername(body.username)].slice(0, MAX_USERNAME_KEY_LENGTH).join('');
  const check = limiter.check(username);
  if (!check.allowed) {
    deps.log.warn('login_throttled', { user: username });
    sendError(res, 429, 'too_many_attempts', { 'Retry-After': String(check.retryAfterSec) });
    return;
  }
  // Count the attempt synchronously, before the first await: otherwise every
  // request arriving while earlier scrypt verifies are still running would
  // pass `check` too. A successful verify resets the key below.
  limiter.fail(username);

  const user = validateUsername(username) === null ? undefined : getUserByUsername(deps.db, username);
  // Always verify against a real hash — the user's own, or the fixed dummy
  // one for an unknown/invalid username or an out-of-range password — so
  // every rejection costs the same time (no username enumeration).
  const hash = user && validatePassword(body.password) ? user.password_hash : DUMMY_HASH;
  const validPassword = await verifyPassword(body.password, hash);
  if (!user || hash === DUMMY_HASH || !validPassword) {
    deps.log.warn('login_failed', { user: username, ip: clientIp(req) });
    sendError(res, 401, 'invalid_credentials');
    return;
  }

  limiter.reset(username);
  // Session-fixation defence: a still-valid prior session cookie is revoked
  // only now, after the password verified — never on a failed/throttled
  // attempt, which must leave the caller's existing session untouched.
  if (ctx.sessionId) deps.sessions.revoke(ctx.sessionId);
  const { token } = deps.sessions.create(user.id);
  setSessionCookie(req, res, token, SESSION_MAX_AGE_SEC);
  deps.log.info('login_ok', { user: username });
  sendJson(res, 200, { id: user.id, username: user.username, role: user.role });
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('../http/router.js').RequestContext} ctx
 * @param {import('../app.js').AppDeps} deps
 * @returns {void}
 */
function handleLogout(req, res, ctx, deps) {
  if (ctx.sessionId) deps.sessions.revoke(ctx.sessionId);
  setSessionCookie(req, res, '', 0);
  deps.log.info('logout', { user: ctx.user?.username });
  sendNoContent(res);
}

/**
 * Registers `POST /login`, `POST /logout` and `GET /api/me`.
 * @param {ReturnType<typeof import('../http/router.js').createRouter>} router
 * @param {import('../app.js').AppDeps} deps
 * @returns {void}
 */
export function registerAuthRoutes(router, deps) {
  const limiter = createLoginLimiter({ now: deps.now });

  router.add('POST', '/login', (req, res, ctx) => handleLogin(req, res, ctx, deps, limiter));
  router.add(
    'POST',
    '/logout',
    requireUser((req, res, ctx) => handleLogout(req, res, ctx, deps)),
  );
  router.add(
    'GET',
    '/api/me',
    requireUser((_req, res, ctx) => {
      sendJson(res, 200, ctx.user);
    }),
  );
}
