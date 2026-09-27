/**
 * Admin user management: `/api/users*`, all behind `requireAdmin`. Validation
 * order and conflict codes follow the spec's HTTP surface table verbatim;
 * the last-admin/self guards that need to know "who is asking" (own id) live
 * here, while the concurrency-safe last-admin check itself lives in
 * `src/db/users.js` (`setRoleGuarded`/`deleteUserGuarded`).
 */

import { hashPassword } from '../auth/password.js';
import { validatePassword, validateRole, validateUsername } from '../auth/validation.js';
import { deleteUserGuarded, getUserById, getUserByUsername, insertUser, listUsers, setPasswordHash, setRoleGuarded } from '../db/users.js';
import { requireAdmin } from '../http/guards.js';
import { HttpError, readJson, sendError, sendJson, sendNoContent } from '../http/respond.js';

/**
 * @param {import('../db/users.js').UserRow} row
 * @returns {{ id: number, username: string, role: 'admin' | 'user', createdAt: string }}
 */
function toUserJson(row) {
  return { id: row.id, username: row.username, role: row.role, createdAt: new Date(row.created_at).toISOString() };
}

/**
 * Parses `:id` as a positive integer (the only shape `AUTOINCREMENT` ids
 * take); anything else is treated the same as an unknown id by the caller.
 * @param {string} raw
 * @returns {number | null}
 */
function parseUserId(raw) {
  return /^[1-9][0-9]*$/.test(raw) ? Number(raw) : null;
}

/**
 * @param {unknown} body
 * @returns {{ username: string, password: string, role: 'admin' | 'user' }}
 * @throws {HttpError} 400 `invalid_json`/`invalid_username`/`invalid_password`/`invalid_role`
 */
function validateCreateBody(body) {
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'invalid_json');
  const { username, password, role = 'user' } = /** @type {Record<string, unknown>} */ (body);
  const normalizedUsername = typeof username === 'string' ? validateUsername(username) : null;
  if (normalizedUsername === null) throw new HttpError(400, 'invalid_username');
  if (typeof password !== 'string' || !validatePassword(password)) throw new HttpError(400, 'invalid_password');
  if (typeof role !== 'string' || !validateRole(role)) throw new HttpError(400, 'invalid_role');
  return { username: normalizedUsername, password, role: /** @type {'admin' | 'user'} */ (role) };
}

/**
 * @param {unknown} body
 * @returns {string} the validated password
 * @throws {HttpError} 400 `invalid_json`/`invalid_password`
 */
function validatePasswordBody(body) {
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'invalid_json');
  const { password } = /** @type {Record<string, unknown>} */ (body);
  if (typeof password !== 'string' || !validatePassword(password)) throw new HttpError(400, 'invalid_password');
  return password;
}

/**
 * @param {unknown} body
 * @returns {'admin' | 'user'} the validated role
 * @throws {HttpError} 400 `invalid_json`/`invalid_role`
 */
function validateRoleBody(body) {
  if (typeof body !== 'object' || body === null) throw new HttpError(400, 'invalid_json');
  const { role } = /** @type {Record<string, unknown>} */ (body);
  if (typeof role !== 'string' || !validateRole(role)) throw new HttpError(400, 'invalid_role');
  return /** @type {'admin' | 'user'} */ (role);
}

/**
 * `GET /api/users` -> `200 [{id, username, role, createdAt}]` ordered by username.
 * @param {import('../app.js').AppDeps} deps
 * @param {import('node:http').ServerResponse} res
 * @returns {void}
 */
function handleList(deps, res) {
  sendJson(res, 200, listUsers(deps.db).map(toUserJson));
}

/**
 * `POST /api/users` -> `201 {id, username, role, createdAt}`; `409 username_taken`.
 * @param {import('../app.js').AppDeps} deps
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('../http/router.js').RequestContext} ctx
 * @returns {Promise<void>}
 */
async function handleCreate(deps, req, res, ctx) {
  const { username, password, role } = validateCreateBody(await readJson(req));
  if (getUserByUsername(deps.db, username)) {
    sendError(res, 409, 'username_taken');
    return;
  }
  const passwordHash = await hashPassword(password);
  const created = insertUser(deps.db, { username, passwordHash, role, createdAt: deps.now() });
  deps.log.info('user_created', { user: created.username, by: ctx.user?.username });
  sendJson(res, 201, toUserJson(created));
}

/**
 * `PUT /api/users/:id/password` -> `204`; `404 not_found`; revokes every
 * session of the target user except the caller's own current one (so an
 * admin resetting their own password stays logged in).
 * @param {import('../app.js').AppDeps} deps
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('../http/router.js').RequestContext} ctx
 * @returns {Promise<void>}
 */
async function handlePasswordReset(deps, req, res, ctx) {
  const password = validatePasswordBody(await readJson(req));
  const id = parseUserId(ctx.params.id);
  const target = id === null ? undefined : getUserById(deps.db, id);
  if (!target) {
    sendError(res, 404, 'not_found');
    return;
  }
  setPasswordHash(deps.db, target.id, await hashPassword(password));
  deps.sessions.revokeUser(target.id, { exceptSessionId: ctx.sessionId });
  deps.log.info('password_reset', { user: target.username, by: ctx.user?.username });
  sendNoContent(res);
}

/**
 * `PATCH /api/users/:id` -> `200 {id, username, role, createdAt}` (same role
 * = no-op); `404 not_found`; `409 cannot_change_own_role|last_admin`.
 * @param {import('../app.js').AppDeps} deps
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {import('../http/router.js').RequestContext} ctx
 * @returns {Promise<void>}
 */
async function handleRoleChange(deps, req, res, ctx) {
  const role = validateRoleBody(await readJson(req));
  const id = parseUserId(ctx.params.id);
  const target = id === null ? undefined : getUserById(deps.db, id);
  if (!target) {
    sendError(res, 404, 'not_found');
    return;
  }
  if (target.role === role) {
    sendJson(res, 200, toUserJson(target));
    return;
  }
  if (ctx.user && target.id === ctx.user.id) {
    sendError(res, 409, 'cannot_change_own_role');
    return;
  }
  const result = setRoleGuarded(deps.db, target.id, role);
  if (result === 'not_found') {
    sendError(res, 404, 'not_found');
    return;
  }
  if (result === 'last_admin') {
    sendError(res, 409, 'last_admin');
    return;
  }
  deps.log.info('role_changed', { user: target.username, by: ctx.user?.username });
  sendJson(res, 200, toUserJson(/** @type {import('../db/users.js').UserRow} */ (getUserById(deps.db, target.id))));
}

/**
 * `DELETE /api/users/:id` -> `204`; `404 not_found`; `409 cannot_delete_self|last_admin`.
 * @param {import('../app.js').AppDeps} deps
 * @param {import('node:http').ServerResponse} res
 * @param {import('../http/router.js').RequestContext} ctx
 * @returns {void}
 */
function handleDelete(deps, res, ctx) {
  const id = parseUserId(ctx.params.id);
  const target = id === null ? undefined : getUserById(deps.db, id);
  if (!target) {
    sendError(res, 404, 'not_found');
    return;
  }
  if (ctx.user && target.id === ctx.user.id) {
    sendError(res, 409, 'cannot_delete_self');
    return;
  }
  const result = deleteUserGuarded(deps.db, target.id);
  if (result === 'not_found') {
    sendError(res, 404, 'not_found');
    return;
  }
  if (result === 'last_admin') {
    sendError(res, 409, 'last_admin');
    return;
  }
  deps.log.info('user_deleted', { user: target.username, by: ctx.user?.username });
  sendNoContent(res);
}

/**
 * Registers `/api/users*` (list, create, reset password, change role,
 * delete), all behind `requireAdmin`.
 * @param {ReturnType<typeof import('../http/router.js').createRouter>} router
 * @param {import('../app.js').AppDeps} deps
 * @returns {void}
 */
export function registerUserRoutes(router, deps) {
  router.add('GET', '/api/users', requireAdmin((_req, res) => handleList(deps, res)));
  router.add('POST', '/api/users', requireAdmin((req, res, ctx) => handleCreate(deps, req, res, ctx)));
  router.add('PUT', '/api/users/:id/password', requireAdmin((req, res, ctx) => handlePasswordReset(deps, req, res, ctx)));
  router.add('PATCH', '/api/users/:id', requireAdmin((req, res, ctx) => handleRoleChange(deps, req, res, ctx)));
  router.add('DELETE', '/api/users/:id', requireAdmin((_req, res, ctx) => handleDelete(deps, res, ctx)));
}
