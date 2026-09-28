import { registerAudiobookRoutes } from '../api/audiobooks.js';
import { registerAuthRoutes } from '../api/auth.js';
import { registerCoverRoutes } from '../api/cover.js';
import { registerGalleryRoutes } from '../api/gallery.js';
import { registerHealthRoutes } from '../api/health.js';
import { registerHomeListeningRoutes } from '../api/home-listening.js';
import { registerHomePreviewsRoutes } from '../api/home-previews.js';
import { registerLibraryRoutes } from '../api/library.js';
import { registerMediaRoutes } from '../api/media.js';
import { registerMusicRoutes } from '../api/music.js';
import { registerProgressRoutes } from '../api/progress.js';
import { registerThumbRoutes } from '../api/thumb.js';
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
  registerHomeListeningRoutes(router, deps);
  registerHomePreviewsRoutes(router, deps);
  registerAuthRoutes(router, deps);
  registerAudiobookRoutes(router, deps);
  registerCoverRoutes(router, deps);
  registerLibraryRoutes(router, deps);
  registerMediaRoutes(router, deps);
  registerMusicRoutes(router, deps);
  registerProgressRoutes(router, deps);
  registerThumbRoutes(router, deps);
  registerGalleryRoutes(router, deps);
  registerUserRoutes(router, deps);
}
