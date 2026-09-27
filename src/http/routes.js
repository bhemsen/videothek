import { registerHealthRoutes } from '../api/health.js';
import { registerUserRoutes } from '../api/users.js';

/**
 * Registers every API module's routes onto `router` — one
 * `register<X>Routes(router, deps)` line per module. Later phases add their
 * own line here as they add API modules.
 * @param {ReturnType<typeof import('./router.js').createRouter>} router
 * @param {import('../app.js').AppDeps} deps
 * @returns {void}
 */
export function registerRoutes(router, deps) {
  registerHealthRoutes(router, deps);
  registerUserRoutes(router, deps);
}
