/**
 * Audio section entry, mounted once per page load on `/music` and
 * `/audiobooks`: pushState routing between the two pages, the one
 * persistent player/bar and Media Session. See
 * spec-music-audiobooks.md "Audio section URLs" and "View contract".
 */
import { mountShell } from '../lib/shell.js';
import { el } from '../lib/dom.js';
import { parseAudioUrl, audioUrl, isFragmentOnlyChange, needsRender } from './routes.js';
import { createAudioPlayer } from './player.js';
import { createPlayerBar } from './player-bar.js';
import { bindMediaSession } from './media-session.js';
import { render as musicOverview } from './views/music-overview.js';
import { render as album } from './views/album.js';
import { render as audiobookGrid } from './views/audiobook-grid.js';
import { render as audiobookDetail } from './views/audiobook-detail.js';

/** @typedef {import('./routes.js').AudioRoute} AudioRoute */
/** @typedef {(route: AudioRoute) => void} Navigate */
/** @typedef {{ container: HTMLElement, id: number | null, player: ReturnType<typeof createAudioPlayer>, navigate: Navigate }} ViewParams */
/** @typedef {(params: ViewParams) => Promise<{ title: string, dispose?: () => void }>} ViewRenderer */
/* A ViewRenderer must never reject (spec "View contract"): renderRoute has no
 * catch, so views own their error state (render it into `container`) and
 * always resolve. */

/** @type {Record<AudioRoute['section'], Record<string, ViewRenderer>>} */
const VIEWS = {
  music: { overview: musicOverview, album },
  audiobooks: { grid: audiobookGrid, book: audiobookDetail },
};

history.scrollRestoration = 'manual';

const initialSection = location.pathname === '/audiobooks' ? 'audiobooks' : 'music';
const { main, setActive } = mountShell({ active: initialSection });
const container = el('div', { class: 'audio-view' });
main.append(container);

const audio = /** @type {HTMLAudioElement} */ (document.createElement('audio'));
audio.preload = 'metadata';
const player = createAudioPlayer({ audio });
const { bar, spacer } = createPlayerBar({ player, audio });
main.append(spacer);
document.body.append(audio, bar);
bindMediaSession(player, audio);

/** @type {{ dispose?: () => void } | null} */
let currentView = null;
/** Bumped on every navigation; a render whose token has gone stale by the
 * time its view promise settles was superseded by a later navigation and is
 * dropped instead of overwriting the newer view. */
let navToken = 0;
/** Canonical URL of the route last rendered; lets `popstate` skip
 * fragment-only history steps (e.g. after the skip link). @type {string | null} */
let renderedUrl = null;

/**
 * Swaps a fresh target into the live `container` synchronously — before the
 * view's (possibly awaited) work even starts — so the view owns `container`
 * from the first paint: a cold load shows the view's own loading state
 * instead of an empty `main`, and in-section navigation drops the previous
 * view immediately instead of leaving it visible and clickable until the
 * fetch resolves. Only `currentView` and `document.title`, which depend on
 * the resolved result, wait for the view's promise, guarded by `navToken` so
 * a superseded render never overwrites a later one. A superseded view's
 * `dispose` still runs even though it never became current.
 * @param {AudioRoute} route
 * @returns {Promise<void>}
 */
async function renderRoute(route) {
  const token = ++navToken;
  renderedUrl = audioUrl(route);
  currentView?.dispose?.();
  currentView = null;
  const view = VIEWS[route.section][route.view];
  const target = el('div');
  container.replaceChildren(target);
  setActive(route.section);
  window.scrollTo(0, 0);
  const result = await view({ container: target, id: route.id, player, navigate });
  if (token !== navToken) {
    result.dispose?.();
    return;
  }
  currentView = result;
  document.title = `${result.title} · Videothek`;
}

/**
 * Pushes `route`'s canonical URL (skipped when unchanged) and renders it.
 * Passed to every view as its `navigate` callback.
 * @type {Navigate}
 */
function navigate(route) {
  const target = audioUrl(route);
  if (target !== location.pathname + location.search) history.pushState(null, '', target);
  renderRoute(route);
}

/**
 * Parses the current location, cleans an invalid/stale query with
 * `replaceState` when the canonical URL differs, and renders it.
 * @returns {void}
 */
function syncFromLocation() {
  const route = parseAudioUrl(location.pathname, location.search);
  const canonical = audioUrl(route);
  if (canonical !== location.pathname + location.search) history.replaceState(null, '', canonical);
  renderRoute(route);
}

/**
 * Intercepts a primary, unmodified click on a same-origin `/music` or
 * `/audiobooks` link (Phase 1's nav entries and every in-section link) and
 * turns it into a `pushState` navigation instead of a page load. A link that
 * only changes the fragment (the shell's "Zum Inhalt springen" `#main`) is
 * left to the browser's native in-page jump.
 * @param {MouseEvent} event
 * @returns {void}
 */
function onClick(event) {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const eventTarget = event.target;
  const closest = eventTarget instanceof Element ? eventTarget.closest('a[href]') : null;
  const anchor = /** @type {HTMLAnchorElement | null} */ (closest);
  if (anchor === null || anchor.target || anchor.hasAttribute('download')) return;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin) return;
  if (url.pathname !== '/music' && url.pathname !== '/audiobooks') return;
  if (isFragmentOnlyChange(url, location)) return;
  event.preventDefault();
  navigate(parseAudioUrl(url.pathname, url.search));
}

document.addEventListener('click', onClick);
window.addEventListener('popstate', () => {
  if (needsRender(location, renderedUrl)) renderRoute(parseAudioUrl(location.pathname, location.search));
});

syncFromLocation();
