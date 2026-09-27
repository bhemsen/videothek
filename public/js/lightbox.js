/**
 * Full-viewport lightbox over a folder's playable items: images shown at
 * full size, videos played inline with native controls. One instance lives
 * for the whole page (its `items` array is refilled in place by `images.js`
 * on every folder render, so its `<dialog>` and history listener are never
 * rebuilt). See docs/specs/spec-image-gallery.md "Lightbox".
 */
import { el } from './lib/dom.js';
import { chevronLeftIcon, chevronRightIcon, closeIcon } from './image-icons.js';
import { formatTakenAt } from './image-format.js';
import { classifySwipe, keyAction } from './lightbox-gestures.js';
import { createLightboxHistory } from './lightbox-history.js';
import { preloadNeighbours, renderSlide } from './lightbox-slide.js';

/** @typedef {import('./image-tiles.js').GalleryItem} GalleryItem */
/**
 * @typedef {object} LightboxDom
 * @property {HTMLDialogElement} dialog
 * @property {HTMLElement} counter
 * @property {HTMLButtonElement} closeButton
 * @property {HTMLButtonElement} prevButton
 * @property {HTMLButtonElement} nextButton
 * @property {HTMLElement} stage
 * @property {HTMLElement} captionName
 * @property {HTMLElement} captionDate
 */

const SCROLL_LOCK_CLASS = 'lightbox-scroll-lock';

/**
 * @param {SVGSVGElement} icon
 * @param {string} label
 * @param {string} gridAreaClass
 * @returns {HTMLButtonElement}
 */
function buildButton(icon, label, gridAreaClass) {
  return /** @type {HTMLButtonElement} */ (
    el('button', { type: 'button', class: `lightbox-btn ${gridAreaClass}`, 'aria-label': label, title: label }, icon)
  );
}

/**
 * Builds the lightbox's `<dialog>` and chrome and appends it to `<body>`.
 * @returns {LightboxDom}
 */
function buildLightboxDom() {
  const counter = el('p', { class: 'lightbox-counter' });
  const closeButton = buildButton(closeIcon(), 'Schließen', 'lightbox-close');
  const prevButton = buildButton(chevronLeftIcon(), 'Vorheriges Bild', 'lightbox-nav--prev');
  const nextButton = buildButton(chevronRightIcon(), 'Nächstes Bild', 'lightbox-nav--next');
  const stage = el('div', { class: 'lightbox-stage' });
  const captionName = el('span', { class: 'lightbox-caption__name' });
  const captionDate = el('span', { class: 'lightbox-caption__date' });
  const caption = el(
    'p',
    { class: 'lightbox-caption', 'aria-live': 'polite' },
    captionName,
    el('span', { class: 'lightbox-caption__sep', 'aria-hidden': 'true' }, ' · '),
    captionDate,
  );
  const hint = el(
    'p',
    { class: 'lightbox-hint', 'aria-hidden': 'true' },
    el('span', { class: 'lightbox-hint__fine' }, '← → Blättern · Esc Schließen'),
    el('span', { class: 'lightbox-hint__coarse' }, 'Wischen zum Blättern'),
  );
  const dialog = /** @type {HTMLDialogElement} */ (
    el(
      'dialog',
      { class: 'lightbox', 'aria-label': 'Bildansicht' },
      counter,
      closeButton,
      prevButton,
      stage,
      nextButton,
      caption,
      hint,
    )
  );
  document.body.append(dialog);
  return { dialog, counter, closeButton, prevButton, nextButton, stage, captionName, captionDate };
}

/**
 * Wires ArrowLeft/ArrowRight on the dialog to `onNavigate` (a focused
 * `<video>` keeps its own arrow keys for native seeking; see `keyAction`).
 * @param {HTMLDialogElement} dialog
 * @param {(direction: -1 | 1) => void} onNavigate
 * @returns {void}
 */
function bindKeys(dialog, onNavigate) {
  dialog.addEventListener('keydown', (event) => {
    const targetTag = event.target instanceof Element ? event.target.tagName : '';
    const { key, altKey, ctrlKey, metaKey } = event;
    const action = keyAction({ key, targetTag, altKey, ctrlKey, metaKey });
    if (action) onNavigate(action === 'prev' ? -1 : 1);
  });
}

/**
 * Wires horizontal pointer swipes on `stage` to `onNavigate`. A drag that
 * starts on a `<video>` is ignored so scrubbing its controls never changes
 * slides.
 * @param {HTMLElement} stage
 * @param {(direction: -1 | 1) => void} onNavigate
 * @returns {void}
 */
function bindSwipe(stage, onNavigate) {
  /** @type {{ x: number, y: number } | null} */
  let pointerStart = null;
  /** @param {PointerEvent} event */
  const onPointerUp = (event) => {
    stage.removeEventListener('pointercancel', onPointerCancel);
    const start = pointerStart;
    pointerStart = null;
    if (!event.isPrimary || !start) return;
    const action = classifySwipe(event.clientX - start.x, event.clientY - start.y);
    if (action) onNavigate(action === 'prev' ? -1 : 1);
  };
  const onPointerCancel = () => {
    stage.removeEventListener('pointerup', onPointerUp);
    pointerStart = null;
  };
  stage.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || event.target instanceof HTMLVideoElement) return;
    pointerStart = { x: event.clientX, y: event.clientY };
    stage.addEventListener('pointerup', onPointerUp, { once: true });
    stage.addEventListener('pointercancel', onPointerCancel, { once: true });
  });
}

/**
 * Updates counter, caption and the prev/next `disabled` state for
 * `sequence[index]`. When the button about to be disabled holds focus, focus
 * first moves to the other nav button (or Schließen when both ends apply),
 * so it never drops out of the dialog to `<body>` and the dialog's arrow-key
 * listener keeps working.
 * @param {LightboxDom} dom
 * @param {GalleryItem[]} sequence
 * @param {number} index
 * @returns {void}
 */
function renderChrome(dom, sequence, index) {
  const item = sequence[index];
  dom.counter.textContent = `${index + 1} / ${sequence.length}`;
  dom.captionName.textContent = item.name;
  dom.captionDate.textContent = formatTakenAt(item.takenAt);
  const atStart = index <= 0;
  const atEnd = index >= sequence.length - 1;
  const active = document.activeElement;
  if (atStart && active === dom.prevButton) (atEnd ? dom.closeButton : dom.nextButton).focus();
  if (atEnd && active === dom.nextButton) (atStart ? dom.closeButton : dom.prevButton).focus();
  dom.prevButton.disabled = atStart;
  dom.nextButton.disabled = atEnd;
}

/**
 * Wires keys, swipes and the three buttons.
 * @param {LightboxDom} dom
 * @param {(direction: -1 | 1) => void} navigate
 * @returns {void}
 */
function bindControls(dom, navigate) {
  bindKeys(dom.dialog, navigate);
  bindSwipe(dom.stage, navigate);
  dom.closeButton.addEventListener('click', () => dom.dialog.close());
  dom.prevButton.addEventListener('click', () => navigate(-1));
  dom.nextButton.addEventListener('click', () => navigate(1));
}

/**
 * @param {{ items: GalleryItem[], onClose: (lastItemId: number | null) => void }} params -
 *   `items` is read fresh on every `open()` call, so the caller may refill
 *   the same array in place between opens instead of constructing a new
 *   lightbox per folder. `onClose` receives the id of the item shown when
 *   the dialog closed, so the caller can restore focus to its tile.
 * @returns {{ open: (itemId: number) => void, close: () => void }}
 */
export function createLightbox({ items, onClose }) {
  /** @type {GalleryItem[]} */
  let sequence = [];
  let currentIndex = -1;
  /** @type {{ release: () => void } | null} */
  let currentSlide = null;
  const dom = buildLightboxDom();
  const { dialog } = dom;
  // popstate past the lightbox's own entry (browser back) closes the dialog.
  const lightboxHistory = createLightboxHistory({ onPop: () => dialog.open && dialog.close() });

  /** @returns {void} Renders `sequence[currentIndex]` and updates the chrome. */
  function renderCurrent() {
    currentSlide?.release();
    currentSlide = renderSlide(dom.stage, sequence[currentIndex]);
    preloadNeighbours(sequence, currentIndex);
    renderChrome(dom, sequence, currentIndex);
  }

  /**
   * No wrap-around: a step past either end is a no-op.
   * @param {-1 | 1} direction
   * @returns {void}
   */
  function navigate(direction) {
    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= sequence.length) return;
    currentIndex = nextIndex;
    lightboxHistory.replace(sequence[currentIndex].id);
    renderCurrent();
  }

  bindControls(dom, navigate);
  dialog.addEventListener('close', () => {
    currentSlide?.release();
    currentSlide = null;
    document.documentElement.classList.remove(SCROLL_LOCK_CLASS);
    const lastItemId = currentIndex >= 0 ? sequence[currentIndex].id : null;
    lightboxHistory.release();
    onClose(lastItemId);
  });

  return {
    open(itemId) {
      sequence = items.filter((item) => item.playable);
      const index = sequence.findIndex((item) => item.id === itemId);
      if (index === -1) return;
      currentIndex = index;
      renderCurrent();
      document.documentElement.classList.add(SCROLL_LOCK_CLASS);
      dialog.showModal();
      dom.closeButton.focus();
      lightboxHistory.push(itemId);
    },
    close() {
      if (dialog.open) dialog.close();
    },
  };
}
