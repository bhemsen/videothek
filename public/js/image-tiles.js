/**
 * Gallery tile markup for `/images` (folder, image, playable video and
 * non-playable tiles) and the folder-link URL builder they share with
 * `images.js`. Own markup rather than P2's shared media card (P4 edits that
 * card in parallel) — see docs/specs/spec-image-gallery.md "Tiles". DOM only
 * via P1's `el()`/`createIcon` — never `innerHTML`.
 */
import { el } from './lib/dom.js';
import { icon } from './lib/icons.js';
import { folderIcon, imageOffIcon, playIcon } from './image-icons.js';
import { countLabel, formatTakenAt, orientationClass } from './image-format.js';

/** @typedef {{ key: string, name: string }} BreadcrumbEntry */
/** @typedef {{ thumbUrl: string | null, thumbOrientation: number }} GalleryCover */
/** @typedef {{ key: string, name: string, count: number, cover: GalleryCover | null }} GalleryFolder */
/** @typedef {{ id: number, name: string, kind: 'image' | 'video', playable: boolean, takenAt: string, url: string | null, thumbUrl: string | null, thumbOrientation: number }} GalleryItem */
/** @typedef {{ key: string, name: string, breadcrumb: BreadcrumbEntry[], folders: GalleryFolder[], items: GalleryItem[] }} GalleryView */

/**
 * Builds the URL for a folder key: the plain root path, or `/images` with the
 * key as its `folder` query parameter.
 * @param {string} key
 * @returns {string}
 */
export function folderUrl(key) {
  return key ? `/images?${new URLSearchParams({ folder: key })}` : '/images';
}

/**
 * Replaces `img` with the generic images fallback glyph once it fails to
 * load — used both as the cover's only fallback step and as the item image
 * tile's final step (after the original also failed).
 * @param {HTMLImageElement} img
 * @returns {void}
 */
function replaceWithFallbackIcon(img) {
  img.replaceWith(el('span', { class: 'gallery-tile__icon' }, icon('images')));
}

/**
 * Wires a folder cover's `<img>` onerror: covers carry no separate original
 * URL, so any failure falls straight back to the fallback glyph.
 * @param {HTMLImageElement} img
 * @returns {void}
 */
function bindCoverFallback(img) {
  img.addEventListener('error', () => replaceWithFallbackIcon(img), { once: true });
}

/**
 * Wires an item image tile's `<img>` onerror: a first failure (still showing
 * the embedded thumbnail) falls back once to the original, resetting the
 * orientation class (the browser applies orientation to originals itself); a
 * second failure (already on the original) falls back to the fallback glyph.
 * @param {HTMLImageElement} img
 * @param {GalleryItem} item
 * @returns {void}
 */
function bindItemThumbFallback(img, item) {
  img.addEventListener('error', () => {
    const original = item.url;
    if (original !== null && img.getAttribute('src') !== original) {
      img.classList.remove(...[...img.classList].filter((c) => c.startsWith('orient-')));
      img.src = original;
      return;
    }
    replaceWithFallbackIcon(img);
  });
}

/**
 * Builds a folder tile: cover thumbnail or the generic fallback glyph, a
 * small folder badge bottom-left, name and file count.
 * @param {GalleryFolder} folder
 * @returns {HTMLElement}
 */
export function createFolderTile(folder) {
  /** @type {HTMLElement} */
  let art;
  if (folder.cover?.thumbUrl) {
    const img = /** @type {HTMLImageElement} */ (el('img', {
      class: ['gallery-tile__img', orientationClass(folder.cover.thumbOrientation)],
      alt: '',
      loading: 'lazy',
      decoding: 'async',
      src: folder.cover.thumbUrl,
    }));
    bindCoverFallback(img);
    art = img;
  } else {
    art = el('span', { class: 'gallery-tile__icon' }, icon('images'));
  }
  const visual = el(
    'span',
    { class: 'gallery-tile__visual' },
    art,
    el('span', { class: 'gallery-tile__folder-badge' }, folderIcon()),
  );
  return el(
    'a',
    { class: 'gallery-tile gallery-tile--folder', href: folderUrl(folder.key) },
    visual,
    el('p', { class: 'gallery-tile__title' }, folder.name),
    el('p', { class: 'gallery-tile__meta' }, countLabel(folder.count)),
  );
}

/**
 * Builds a playable image tile: a `<button>` with the thumbnail/original
 * image, file name and capture date.
 * @param {GalleryItem} item
 * @returns {HTMLElement}
 */
function createImageTile(item) {
  const img = /** @type {HTMLImageElement} */ (el('img', {
    class: ['gallery-tile__img', orientationClass(item.thumbOrientation)],
    alt: '',
    loading: 'lazy',
    decoding: 'async',
    src: item.thumbUrl,
  }));
  bindItemThumbFallback(img, item);
  return el(
    'button',
    { type: 'button', class: 'gallery-tile gallery-tile--item', dataset: { itemId: String(item.id) }, 'aria-label': item.name },
    el('span', { class: 'gallery-tile__visual' }, img),
    el('span', { class: 'gallery-tile__title' }, item.name),
    el('span', { class: 'gallery-tile__meta' }, formatTakenAt(item.takenAt)),
  );
}

/**
 * Builds a playable video tile: a `<button>` with a play glyph placeholder,
 * file name and the "Video" meta label.
 * @param {GalleryItem} item
 * @returns {HTMLElement}
 */
function createVideoTile(item) {
  return el(
    'button',
    {
      type: 'button',
      class: 'gallery-tile gallery-tile--item gallery-tile--video',
      dataset: { itemId: String(item.id) },
      'aria-label': `${item.name}, Video`,
    },
    el('span', { class: 'gallery-tile__visual' }, el('span', { class: 'gallery-tile__icon' }, playIcon())),
    el('span', { class: 'gallery-tile__title' }, item.name),
    el('span', { class: 'gallery-tile__meta' }, 'Video'),
  );
}

/**
 * Builds a non-playable tile (image or video): a non-interactive `<div>`
 * with the crossed-out glyph, the matching "Nicht anzeigbar"/"Nicht
 * abspielbar" badge, file name and its normal (date/"Video") meta.
 * @param {GalleryItem} item
 * @returns {HTMLElement}
 */
function createNonPlayableTile(item) {
  const badgeText = item.kind === 'video' ? 'Nicht abspielbar' : 'Nicht anzeigbar';
  const metaText = item.kind === 'video' ? 'Video' : formatTakenAt(item.takenAt);
  return el(
    'div',
    { class: 'gallery-tile gallery-tile--item gallery-tile--static', dataset: { itemId: String(item.id) } },
    el(
      'span',
      { class: 'gallery-tile__visual' },
      el('span', { class: 'gallery-tile__icon' }, imageOffIcon()),
      el('span', { class: 'gallery-badge' }, badgeText),
    ),
    el('span', { class: 'gallery-tile__title' }, item.name),
    el('span', { class: 'gallery-tile__meta' }, metaText),
  );
}

/**
 * Builds one item tile, dispatching on playability and kind.
 * @param {GalleryItem} item
 * @returns {HTMLElement}
 */
export function createItemTile(item) {
  if (!item.playable) return createNonPlayableTile(item);
  return item.kind === 'video' ? createVideoTile(item) : createImageTile(item);
}
