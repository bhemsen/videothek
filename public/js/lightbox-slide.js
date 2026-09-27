/**
 * Lightbox slide content: builds the `<img>`/`<video>` for one gallery item
 * and its load-error fallback, plus bounded neighbour preloading. No history
 * or dialog concerns — those live in `lightbox.js`/`lightbox-history.js`. See
 * docs/specs/spec-image-gallery.md "Lightbox".
 */
import { el } from './lib/dom.js';

/** @typedef {import('./image-tiles.js').GalleryItem} GalleryItem */

/** @type {Record<'image' | 'video', string>} */
const ERROR_TEXT = {
  image: 'Bild konnte nicht geladen werden.',
  video: 'Video konnte nicht abgespielt werden.',
};

/**
 * Builds the slide's media element: the original image, or a native video
 * player (no autoplay — the spec forbids it; a click/tap on `controls`
 * starts playback).
 * @param {GalleryItem} item
 * @returns {HTMLImageElement | HTMLVideoElement}
 */
function buildMedia(item) {
  if (item.kind === 'video') {
    return /** @type {HTMLVideoElement} */ (
      el('video', {
        class: 'lightbox-slide__media',
        controls: true,
        preload: 'metadata',
        playsinline: true,
        src: item.url,
      })
    );
  }
  return /** @type {HTMLImageElement} */ (
    el('img', { class: 'lightbox-slide__media', src: item.url, alt: '' })
  );
}

/**
 * Renders `item` into `stage`, replacing whatever it currently holds, and
 * wires a load-error fallback message. Returns the handle the lightbox calls
 * when leaving this slide.
 * @param {HTMLElement} stage
 * @param {GalleryItem} item
 * @returns {{ release: () => void }}
 */
export function renderSlide(stage, item) {
  const media = buildMedia(item);
  media.addEventListener(
    'error',
    () => {
      // A stale event from a slide already replaced by a later renderSlide
      // call must never stomp on the slide showing now.
      if (!media.isConnected) return;
      stage.replaceChildren(el('p', { class: 'lightbox-slide__error' }, ERROR_TEXT[item.kind]));
    },
    { once: true },
  );
  stage.replaceChildren(media);
  return {
    release() {
      if (media instanceof HTMLVideoElement) {
        media.pause();
        media.removeAttribute('src');
        media.load();
      }
    },
  };
}

/**
 * Preloads the previous and next item's image (never a video) so stepping
 * one slide over shows an already-cached original.
 * @param {GalleryItem[]} items - The lightbox's playable sequence.
 * @param {number} index - The currently shown item's index in `items`.
 * @returns {void}
 */
export function preloadNeighbours(items, index) {
  for (const neighbour of [items[index - 1], items[index + 1]]) {
    if (neighbour && neighbour.kind === 'image' && neighbour.url) new Image().src = neighbour.url;
  }
}
