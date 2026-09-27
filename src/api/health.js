import { ping } from '../db/index.js';
import { sendError, sendJson } from '../http/respond.js';

/**
 * Registers `GET /healthz` (reachable without a session; `HEAD` is served by
 * the router's automatic `GET` fallback): `200 {"status":"ok"}`, or
 * `503 {"error":"db_unavailable"}` when `ping(db)` reports the database
 * connection unresponsive.
 * @param {ReturnType<typeof import('../http/router.js').createRouter>} router
 * @param {{ db: import('node:sqlite').DatabaseSync }} deps
 * @returns {void}
 */
export function registerHealthRoutes(router, { db }) {
  router.add('GET', '/healthz', (_req, res) => {
    if (ping(db)) {
      sendJson(res, 200, { status: 'ok' });
    } else {
      sendError(res, 503, 'db_unavailable');
    }
  });
}
