/**
 * Batched rendering of gallery item tiles into a grid: the first batch
 * immediately, later ones as a trailing sentinel scrolls into range, plus an
 * `ensureRendered` escape hatch so the lightbox can force a specific item's
 * tile into existence before focusing it on close. Split out of `images.js`
 * to stay within the constitution's 300-line file cap (Decision log). See
 * docs/specs/spec-image-gallery.md.
 */
import { el } from './lib/dom.js';
import { createItemTile } from './image-tiles.js';

const GALLERY_BATCH_SIZE = 120;
const GALLERY_BATCH_ROOT_MARGIN_PX = 800;

/**
 * Mounts `items` into `grid` in batches of `GALLERY_BATCH_SIZE`: the first
 * batch immediately, later ones when a trailing sentinel comes within
 * `GALLERY_BATCH_ROOT_MARGIN_PX` of the viewport (`IntersectionObserver`,
 * re-observed after each batch so a sentinel that stays in range keeps
 * loading).
 * @param {HTMLElement} grid
 * @param {import('./image-tiles.js').GalleryItem[]} items
 * @returns {{ disconnect: () => void, ensureRendered: (itemId: number) => void }}
 */
export function mountBatchedItems(grid, items) {
  const sentinel = el('div', { class: 'gallery-sentinel', 'aria-hidden': 'true' });
  let rendered = 0;
  /** @param {number} count */
  const renderBatch = (count) => {
    for (const item of items.slice(rendered, rendered + count)) {
      grid.insertBefore(createItemTile(item), sentinel);
    }
    rendered = Math.min(rendered + count, items.length);
    if (rendered >= items.length) {
      observer.disconnect();
      sentinel.remove();
    }
  };
  const observer = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      renderBatch(GALLERY_BATCH_SIZE);
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
  renderBatch(GALLERY_BATCH_SIZE);
  if (rendered < items.length) observer.observe(sentinel);
  return {
    disconnect: () => observer.disconnect(),
    // Renders every batch up to and including `itemId`'s tile.
    ensureRendered: (itemId) => {
      const index = items.findIndex((item) => item.id === itemId);
      if (index === -1 || index < rendered) return;
      renderBatch(index - rendered + 1);
    },
  };
}
