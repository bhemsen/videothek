import { registerAudiobookRoutes } from '../api/audiobooks.js';
import { registerGalleryRoutes } from '../api/gallery.js';
import { registerHealthRoutes } from '../api/health.js';
import { registerMusicRoutes } from '../api/music.js';
import { registerThumbRoutes } from '../api/thumb.js';

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
  registerAudiobookRoutes(router, deps);
  registerMusicRoutes(router, deps);
  registerThumbRoutes(router, deps);
  registerGalleryRoutes(router, deps);
}
