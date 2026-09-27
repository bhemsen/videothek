/**
 * Resume toast (docs/specs/spec-progress-resume.md "UI behaviour"): shown
 * once `trackPlayback`'s auto-resume seek lands, offering "Von vorn" to
 * restart from 0. Injects its own stylesheet since no other phase's HTML
 * file is edited; icons beyond P1's set are defined here with P1's
 * `createIcon` (`public/js/lib/icons.js` is never edited).
 */

import { el } from './dom.js';
import { createIcon } from './icons.js';
import { formatClock } from './progress.js';

/** @typedef {{ media: HTMLVideoElement, position: number }} ShowResumeToastOptions */

const STYLESHEET_HREF = '/css/resume-toast.css';
const AUTO_HIDE_MS = 8_000;
const CLOSE_LABEL = 'Hinweis schließen';
// Material Design "refresh" (clockwise rotate arrow, as in the mockup) and "close" glyphs (24x24 grid).
const ROTATE_ICON_PATH =
  'M17.65 6.35C16.2 4.9 14.21 4 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z';
const CLOSE_ICON_PATH = 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';

/** @type {Promise<void> | null} */
let stylesheetReady = null;

/**
 * Appends the toast's stylesheet to `<head>` once and resolves when it has
 * loaded (or failed). The toast is only inserted after that, so it is never
 * laid out unstyled and `--resume-toast-top` is always measured against the
 * host's `position: relative`, which lives in that sheet.
 * @returns {Promise<void>}
 */
function ensureStylesheet() {
  if (stylesheetReady !== null) return stylesheetReady;
  const existing = /** @type {HTMLLinkElement | null} */ (document.head.querySelector(`link[href="${STYLESHEET_HREF}"]`));
  if (existing !== null && existing.sheet !== null) return (stylesheetReady = Promise.resolve());
  const link = existing ?? /** @type {HTMLLinkElement} */ (el('link', { rel: 'stylesheet', href: STYLESHEET_HREF }));
  stylesheetReady = new Promise((resolve) => {
    link.addEventListener('load', () => resolve(), { once: true });
    link.addEventListener('error', () => resolve(), { once: true });
  });
  if (existing === null) document.head.append(link);
  return stylesheetReady;
}

/**
 * Keeps `--resume-toast-top` on `host` equal to the video's bottom edge (the
 * desktop-only absolute position; unused by the mobile in-flow layout), kept
 * live for the toast's whole lifetime by a `ResizeObserver` on the video.
 * @param {HTMLElement} host @param {HTMLVideoElement} media @returns {() => void} disconnect
 */
function trackVideoBottom(host, media) {
  const update = () => host.style.setProperty('--resume-toast-top', `${media.offsetTop + media.offsetHeight}px`);
  update();
  if (typeof ResizeObserver === 'undefined') return () => {};
  const observer = new ResizeObserver(update);
  observer.observe(media);
  return () => observer.disconnect();
}

/** One toast instance; see `showResumeToast`. */
class ResumeToast {
  /** @param {HTMLVideoElement} media @param {number} position */
  constructor(media, position) {
    this.media = media;
    this.position = position;
    this.hidden = false;
    this.pointerInside = false;
    this.focusInside = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.timer = null;
    /** @type {() => void} */
    this.disconnectResize = () => {};
    this.hide = this.hide.bind(this);
    this.toast = el('div', {
      class: 'resume-toast',
      role: 'status',
      onPointerenter: () => this.setPointerInside(true),
      onPointerleave: () => this.setPointerInside(false),
      onFocusin: () => this.setFocusInside(true),
      onFocusout: (/** @type {FocusEvent} */ event) =>
        this.setFocusInside(this.toast.contains(/** @type {Node | null} */ (event.relatedTarget))),
      onKeydown: (/** @type {KeyboardEvent} */ event) => {
        if (event.key === 'Escape') this.close();
      },
    });
    media.addEventListener('emptied', this.hide);
    media.addEventListener('error', this.hide);
  }

  /** Inserts the (still empty) toast right after the media element. @returns {void} */
  show() {
    const host = this.media.parentElement;
    if (this.hidden || host === null) return;
    host.classList.add('resume-toast-host');
    this.disconnectResize = trackVideoBottom(host, this.media);
    this.media.after(this.toast);
    requestAnimationFrame(() => this.fill());
    this.syncTimer();
  }

  /** Fills the live region one frame after insertion so it is announced once. @returns {void} */
  fill() {
    if (this.hidden) return;
    this.toast.append(
      el('span', { class: 'resume-toast__icon' }, createIcon([ROTATE_ICON_PATH])),
      el('p', { class: 'resume-toast__text' }, `Fortgesetzt bei ${formatClock(this.position)}`),
      el('button', { type: 'button', class: 'btn btn-secondary resume-toast__resume', onClick: () => this.restartFromZero() }, 'Von vorn'),
      el(
        'button',
        { type: 'button', class: 'resume-toast__close', 'aria-label': CLOSE_LABEL, onClick: () => this.close() },
        createIcon([CLOSE_ICON_PATH]),
      ),
    );
  }

  /** @param {boolean} inside @returns {void} */
  setPointerInside(inside) {
    this.pointerInside = inside;
    this.syncTimer();
  }

  /** @param {boolean} inside @returns {void} */
  setFocusInside(inside) {
    this.focusInside = inside;
    this.syncTimer();
  }

  /** Paused while the pointer is over the toast or focus is inside it; otherwise a full 8 s from now. @returns {void} */
  syncTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.hidden || this.pointerInside || this.focusInside) return;
    this.timer = setTimeout(this.hide, AUTO_HIDE_MS);
  }

  /** "Von vorn": restart at 0, then close. @returns {void} */
  restartFromZero() {
    this.media.currentTime = 0;
    this.close();
  }

  /** User-initiated close ("×", Escape, "Von vorn"): focus goes back to the media element. @returns {void} */
  close() {
    this.hide();
    this.media.focus();
  }

  /** Removes the toast and every listener/observer/timer it owns; idempotent. @returns {void} */
  hide() {
    if (this.hidden) return;
    this.hidden = true;
    this.syncTimer();
    this.disconnectResize();
    this.media.removeEventListener('emptied', this.hide);
    this.media.removeEventListener('error', this.hide);
    this.toast.remove();
  }
}

/**
 * Shows the resume toast right after `media` (host = its parent element,
 * given `resume-toast-host` for the desktop absolute positioning) once its
 * stylesheet has loaded. Auto-hides after 8 s, paused while the pointer is
 * over the toast or focus is inside it and restarted (full 8 s) once neither
 * holds; closes on Escape, the "×", or the media's `emptied`/`error` events
 * (a playback error must never leave the toast beside P3's error panel).
 * "Von vorn" restarts from 0. The toast is inserted empty and filled on the
 * next animation frame so screen readers register the `role="status"` region
 * before it gets its content.
 * @param {ShowResumeToastOptions} options
 * @returns {{ hide: () => void }}
 */
export function showResumeToast({ media, position }) {
  const toast = new ResumeToast(media, position);
  ensureStylesheet().then(() => toast.show());
  return { hide: toast.hide };
}
