/**
 * Gallery page (`/images`): shell, breadcrumb, header meta, "Ordner"/"Bilder"
 * sections, batched item rendering and all empty/error states. Folder
 * navigation is client-side (`pushState`, no reload) between `/images` and
 * `/images?folder=<key>`, mirroring `public/js/audio/app.js`'s routing.
 * Lightbox wiring is added by #84. See docs/specs/spec-image-gallery.md.
 */
import { createEmptyState, el } from './lib/dom.js';
import { mountShell } from './lib/shell.js';
import { ApiError, request } from './lib/api.js';
import { createFolderTile, createItemTile, folderUrl } from './image-tiles.js';
import { headerMeta } from './image-format.js';

/** @typedef {import('./image-tiles.js').GalleryView} GalleryView */

const EMPTY_ROOT_TITLE = 'Noch keine Bilder';
const EMPTY_ROOT_TEXT =
  'Lege Bilder im Ordner „Bilder“ ab – neue Dateien erscheinen nach wenigen Sekunden automatisch.';
const GALLERY_BATCH_SIZE = 120;
const GALLERY_BATCH_ROOT_MARGIN_PX = 800;

history.scrollRestoration = 'manual';

const { main } = mountShell({ active: 'images' });

/** Bumped on every `renderFolder` call so a slow, superseded fetch never
 * overwrites a later navigation's result. */
let navToken = 0;
/** The batched-rendering controller for the currently mounted items grid, if
 * any, disconnected before a new folder is rendered. @type {{ disconnect: () => void } | null} */
let batchController = null;
/** Folder key of the view last rendered (or being fetched); lets `popstate`
 * skip fragment-only history steps (the skip link's `#main`, #84's
 * `#bild-<id>` lightbox entries), mirroring P5's `needsRender` guard in
 * `public/js/audio/app.js`. @type {string | null} */
let renderedKey = null;

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
 * Mounts `items` into `grid` in batches of `GALLERY_BATCH_SIZE`: the first
 * batch immediately, later ones when a trailing sentinel comes within
 * `GALLERY_BATCH_ROOT_MARGIN_PX` of the viewport (`IntersectionObserver`,
 * re-observed after each batch so a sentinel that stays in range keeps
 * loading).
 * @param {HTMLElement} grid
 * @param {import('./image-tiles.js').GalleryItem[]} items
 * @returns {{ disconnect: () => void }}
 */
function mountBatchedItems(grid, items) {
  const sentinel = el('div', { class: 'gallery-sentinel', 'aria-hidden': 'true' });
  let rendered = 0;
  const renderNextBatch = () => {
    for (const item of items.slice(rendered, rendered + GALLERY_BATCH_SIZE)) {
      grid.insertBefore(createItemTile(item), sentinel);
    }
    rendered = Math.min(rendered + GALLERY_BATCH_SIZE, items.length);
    if (rendered >= items.length) {
      observer.disconnect();
      sentinel.remove();
    }
  };
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      renderNextBatch();
      // Re-observe so a sentinel still within the margin after this batch
      // (very tall viewports) triggers a fresh callback instead of stalling.
      if (rendered < items.length) {
        observer.unobserve(sentinel);
        observer.observe(sentinel);
      }
    },
    { rootMargin: `${GALLERY_BATCH_ROOT_MARGIN_PX}px` },
  );
  grid.append(sentinel);
  renderNextBatch();
  if (rendered < items.length) observer.observe(sentinel);
  return { disconnect: () => observer.disconnect() };
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

document.addEventListener('click', onClick);
window.addEventListener('popstate', () => {
  const key = folderKeyFromLocation();
  if (key !== renderedKey) renderFolder(key, true);
});

renderFolder(folderKeyFromLocation(), false);
