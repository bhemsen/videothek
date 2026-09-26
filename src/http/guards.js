import { sendError } from './respond.js';

/**
 * @typedef {import('./router.js').Handler} Handler
 */

/**
 * Wraps a handler so it requires an authenticated session; without one it
 * answers `401 unauthorized`.
 * @param {Handler} handler
 * @returns {Handler}
 */
export function requireUser(handler) {
  return (req, res, ctx) => {
    if (!ctx.user) {
      sendError(res, 401, 'unauthorized');
      return undefined;
    }
    return handler(req, res, ctx);
  };
}

/**
 * Wraps a handler so it requires an authenticated admin session; without a
 * session it answers `401 unauthorized`, with a non-admin session `403
 * forbidden`.
 * @param {Handler} handler
 * @returns {Handler}
 */
export function requireAdmin(handler) {
  return requireUser((req, res, ctx) => {
    if (ctx.user?.role !== 'admin') {
      sendError(res, 403, 'forbidden');
      return undefined;
    }
    return handler(req, res, ctx);
  });
}
