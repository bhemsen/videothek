/**
 * Gallery page (`/images`): shell, breadcrumb, header meta, "Ordner"/"Bilder"
 * sections, batched item rendering, all empty/error states and the lightbox
 * (click-to-open, `#bild-<id>` on load, focus return to the last shown
 * tile). Folder navigation is client-side (`pushState`, no reload) between
 * `/images` and `/images?folder=<key>`, mirroring
 * `public/js/audio/app.js`'s routing. See docs/specs/spec-image-gallery.md.
 */
import { createEmptyState, el } from './lib/dom.js';
import { mountShell } from './lib/shell.js';
import { ApiError, request } from './lib/api.js';
import { createFolderTile, folderUrl } from './image-tiles.js';
import { headerMeta, parseBildHash } from './image-format.js';
import { createLightbox } from './lightbox.js';
import { mountBatchedItems } from './image-batch.js';

/** @typedef {import('./image-tiles.js').GalleryView} GalleryView */

const EMPTY_ROOT_TITLE = 'Noch keine Bilder';
const EMPTY_ROOT_TEXT =
  'Lege Bilder im Ordner „Bilder“ ab – neue Dateien erscheinen nach wenigen Sekunden automatisch.';

history.scrollRestoration = 'manual';

const { main } = mountShell({ active: 'images' });

/** Bumped on every `renderFolder` call so a slow, superseded fetch never
 * overwrites a later navigation's result. */
let navToken = 0;
/** The batched-rendering controller for the currently mounted items grid, if
 * any, disconnected before a new folder is rendered.
 * @type {{ disconnect: () => void, ensureRendered: (itemId: number) => void } | null} */
let batchController = null;
/** Folder key of the view last rendered (or being fetched); lets `popstate`
 * skip fragment-only history steps (the skip link's `#main`, the lightbox's
 * `#bild-<id>` entries), mirroring P5's `needsRender` guard in
 * `public/js/audio/app.js`. @type {string | null} */
let renderedKey = null;
/** The current folder view's items, refilled in place on every render so the
 * one page-lifetime lightbox instance below always opens against the
 * currently displayed folder. @type {import('./image-tiles.js').GalleryItem[]} */
const lightboxItems = [];
/** True once the initial `#bild-<id>` hash (if any) has been handled, so a
 * later folder render never re-opens it. */
let initialHashHandled = false;
const lightbox = createLightbox({ items: lightboxItems, onClose: handleLightboxClose });

/**
 * Reads the folder key from the current location's `?folder=` parameter.
 * @returns {string}
 */
function folderKeyFromLocation() {
  return new URLSearchParams(location.search).get('folder') ?? '';
}

/**
 * Builds the breadcrumb's ordered `{ name, href }` entries: root "Bilder"
 * first (a link unless it is also the current folder), then every ancestor,
 * then the current folder name (never a link) when not at the root.
 * @param {GalleryView} view
 * @returns {{ name: string, href: string | null }[]}
 */
function breadcrumbEntries(view) {
  const entries = [{ key: '', name: 'Bilder' }, ...view.breadcrumb].map((entry) => ({
    name: entry.name,
    href: /** @type {string | null} */ (folderUrl(entry.key)),
  }));
  if (view.key === '') entries[0] = { name: 'Bilder', href: null };
  else entries.push({ name: view.name, href: null });
  return entries;
}

/**
 * Renders the `<nav aria-label="Pfad">` breadcrumb.
 * @param {GalleryView} view
 * @returns {HTMLElement}
 */
function renderBreadcrumb(view) {
  const items = breadcrumbEntries(view).flatMap((entry, index) => {
    const content = entry.href
      ? el('a', { href: entry.href }, entry.name)
      : el('span', { 'aria-current': 'page' }, entry.name);
    const li = el('li', {}, content);
    return index === 0 ? [li] : [el('li', { 'aria-hidden': 'true', class: 'gallery-breadcrumb__sep' }, '›'), li];
  });
  return el('nav', { 'aria-label': 'Pfad', class: 'gallery-breadcrumb' }, el('ol', {}, ...items));
}

/**
 * Renders the heading (root: "Bilder", folder: its name) and, when non-empty,
 * the "{n} Ordner · {m} Dateien" meta line.
 * @param {GalleryView} view
 * @returns {HTMLElement}
 */
function renderHeader(view) {
  const heading = el('h1', { class: 'shell-title', tabindex: '-1' }, view.key === '' ? 'Bilder' : view.name);
  const metaText = headerMeta(view.folders.length, view.items.length);
  /** @type {HTMLElement[]} */
  const children = [heading];
  if (metaText) children.push(el('p', { class: 'gallery-header-meta' }, metaText));
  return el('div', { class: 'gallery-header' }, ...children);
}

/**
 * Renders one successfully loaded folder view: title, breadcrumb, header,
 * "Ordner"/"Bilder" sections (each hidden when empty) and the root empty
 * state when the whole library has nothing yet.
 * @param {GalleryView} view
 * @param {boolean} focusHeading
 * @returns {void}
 */
function renderView(view, focusHeading) {
  batchController?.disconnect();
  batchController = null;
  lightboxItems.length = 0;
  // Plain loop, not `push(...view.items)`: spreading a very large folder
  // would exceed the engine's argument limit.
  for (const item of view.items) lightboxItems.push(item);
  document.title = view.key === '' ? 'Bilder – Videothek' : `${view.name} – Bilder – Videothek`;
  const heading = renderHeader(view);
  /** @type {HTMLElement[]} */
  const sections = [renderBreadcrumb(view), heading];
  if (view.folders.length > 0) {
    const grid = el('div', { class: 'gallery-grid' }, ...view.folders.map(createFolderTile));
    sections.push(el('section', { class: 'gallery-section' }, el('h2', {}, 'Ordner'), grid));
  }
  if (view.items.length > 0) {
    const grid = el('div', { class: 'gallery-grid' });
    sections.push(el('section', { class: 'gallery-section' }, el('h2', {}, 'Bilder'), grid));
    batchController = mountBatchedItems(grid, view.items);
  }
  if (view.key === '' && view.folders.length === 0 && view.items.length === 0) {
    sections.push(createEmptyState({ title: EMPTY_ROOT_TITLE, text: EMPTY_ROOT_TEXT }));
  }
  main.replaceChildren(...sections);
  window.scrollTo(0, 0);
  if (focusHeading) /** @type {HTMLElement} */ (heading.querySelector('h1'))?.focus();
  openFromInitialHash(view);
}

/**
 * Restores focus to the last shown item's tile after the lightbox closes,
 * rendering whatever batch holds it first so the tile exists to focus.
 * @param {number | null} lastItemId
 * @returns {void}
 */
function handleLightboxClose(lastItemId) {
  if (lastItemId === null) return;
  batchController?.ensureRendered(lastItemId);
  const tile = main.querySelector(`[data-item-id="${lastItemId}"]`);
  if (tile instanceof HTMLElement) {
    tile.focus();
    tile.scrollIntoView({ block: 'nearest' });
  }
}

/**
 * Handles a `#bild-<id>` hash present on the very first page load (a reload
 * or a shared link), once: the hash is dropped from the current entry's URL.
 * A hash naming a playable item here reopens the lightbox; a reloaded
 * `{ lightbox }` state is kept so `push()` reuses the entry and Back lands on
 * the folder entry below it. Otherwise the state is cleared to `null`.
 * @param {GalleryView} view
 * @returns {void}
 */
function openFromInitialHash(view) {
  if (initialHashHandled) return;
  initialHashHandled = true;
  const itemId = parseBildHash(location.hash);
  if (itemId === null) return;
  const reopen = view.items.some((item) => item.id === itemId && item.playable);
  // A reloaded lightbox entry keeps its state only when it reopens (push reuses it).
  history.replaceState(reopen ? history.state : null, '', location.pathname + location.search);
  if (!reopen) return;
  batchController?.ensureRendered(itemId);
  lightbox.open(itemId);
}

/**
 * Renders the "Ordner nicht gefunden." state with a link back to the root.
 * @returns {void}
 */
function renderNotFound() {
  main.replaceChildren(
    el(
      'div',
      { class: 'empty-state' },
      el('p', { class: 'empty-state-title' }, 'Ordner nicht gefunden.'),
      el('a', { class: 'empty-state-text', href: '/images' }, 'Zu Bilder'),
    ),
  );
}

/**
 * Renders the generic load-error state with a retry button that re-runs the
 * fetch for `key`.
 * @param {string} key
 * @returns {void}
 */
function renderLoadError(key) {
  const retry = el('button', { type: 'button', class: 'btn btn-secondary' }, 'Erneut versuchen');
  retry.addEventListener('click', () => renderFolder(key, false));
  main.replaceChildren(
    el(
      'div',
      { class: 'empty-state' },
      el('p', { class: 'empty-state-title' }, 'Bilder konnten nicht geladen werden.'),
      retry,
    ),
  );
}

/**
 * Fetches and renders one folder, guarded against a stale, superseded
 * response by `navToken`.
 * @param {string} key
 * @param {boolean} focusHeading
 * @returns {Promise<void>}
 */
async function renderFolder(key, focusHeading) {
  const token = ++navToken;
  renderedKey = key;
  batchController?.disconnect();
  batchController = null;
  try {
    const { data } = await request('GET', `/api/gallery?folder=${encodeURIComponent(key)}`);
    if (token !== navToken) return;
    renderView(/** @type {GalleryView} */ (data), focusHeading);
  } catch (error) {
    if (token !== navToken) return;
    if (error instanceof ApiError && error.status === 404) renderNotFound();
    else renderLoadError(key);
  }
}

/**
 * Pushes `key`'s canonical URL (skipped when unchanged) and renders it.
 * @param {string} key
 * @returns {void}
 */
function navigate(key) {
  const target = folderUrl(key);
  if (target !== location.pathname + location.search) history.pushState(null, '', target);
  renderFolder(key, true);
}

/**
 * True when following a link only changes the fragment (the shell's "Zum
 * Inhalt springen" skip link) — such a link keeps the browser's native
 * in-page jump instead of becoming a route render.
 * @param {URL} url
 * @returns {boolean}
 */
function isFragmentOnlyChange(url) {
  return url.hash !== '' && url.pathname === location.pathname && url.search === location.search;
}

/**
 * Intercepts a primary, unmodified click on a same-origin `/images` link
 * (folder tiles, breadcrumb links, the "Zu Bilder" error link) and turns it
 * into a `pushState` navigation instead of a page load.
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
  if (url.origin !== location.origin || url.pathname !== '/images') return;
  if (isFragmentOnlyChange(url)) return;
  event.preventDefault();
  navigate(url.searchParams.get('folder') ?? '');
}

/**
 * Opens the lightbox when a playable item tile (image or video button, never
 * the non-playable `<div>`) is clicked.
 * @param {MouseEvent} event
 * @returns {void}
 */
function onItemTileClick(event) {
  const target = event.target instanceof Element ? event.target.closest('button[data-item-id]') : null;
  if (!(target instanceof HTMLButtonElement)) return;
  lightbox.open(Number(target.dataset.itemId));
}

document.addEventListener('click', onClick);
main.addEventListener('click', onItemTileClick);
window.addEventListener('popstate', () => {
  const key = folderKeyFromLocation();
  if (key !== renderedKey) renderFolder(key, true);
});

renderFolder(folderKeyFromLocation(), false);
