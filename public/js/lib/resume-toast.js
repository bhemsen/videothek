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
// Material Design "replay" and "close" glyphs (24x24 grid), matching P1/P3's icon style.
const REPLAY_ICON_PATH =
  'M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z';
const CLOSE_ICON_PATH = 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z';

/** Appends the toast's stylesheet to `<head>` once, idempotently. @returns {void} */
function injectStylesheet() {
  if (document.head.querySelector(`link[href="${STYLESHEET_HREF}"]`)) return;
  document.head.append(el('link', { rel: 'stylesheet', href: STYLESHEET_HREF }));
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

/**
 * Shows the resume toast right after `media` (host = its parent element,
 * given `resume-toast-host` for the desktop absolute positioning). Auto-hides
 * after 8 s, paused while the pointer is over the toast or focus is inside
 * it and restarted (full 8 s) on leave/blur; closes on Escape, the "×", or
 * the media's `emptied`/`error` events (a playback error must never leave
 * the toast beside P3's error panel). "Von vorn" restarts from 0. The toast
 * is inserted empty and filled on the next animation frame so screen
 * readers register the `role="status"` region before it gets its content.
 * @param {ShowResumeToastOptions} options
 * @returns {{ hide: () => void }}
 */
export function showResumeToast({ media, position }) {
  injectStylesheet();
  const host = /** @type {HTMLElement} */ (media.parentElement);
  host.classList.add('resume-toast-host');
  const disconnectResize = trackVideoBottom(host, media);

  let hidden = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;

  const toast = el('div', {
    class: 'resume-toast',
    role: 'status',
    onPointerenter: pauseTimer,
    onPointerleave: restartTimer,
    onFocusin: pauseTimer,
    onFocusout: restartTimer,
    onKeydown: onToastKeydown,
  });

  /** @returns {void} */
  function pauseTimer() {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  /** @returns {void} */
  function restartTimer() {
    pauseTimer();
    timer = setTimeout(hide, AUTO_HIDE_MS);
  }

  /** @param {KeyboardEvent} event @returns {void} */
  function onToastKeydown(event) {
    if (event.key !== 'Escape') return;
    hide();
    media.focus();
  }

  /** @returns {void} */
  function restartFromZero() {
    media.currentTime = 0;
    hide();
    media.focus();
  }

  /** @returns {void} */
  function hide() {
    if (hidden) return;
    hidden = true;
    pauseTimer();
    disconnectResize();
    media.removeEventListener('emptied', hide);
    media.removeEventListener('error', hide);
    toast.remove();
  }

  media.addEventListener('emptied', hide);
  media.addEventListener('error', hide);
  host.append(toast);
  requestAnimationFrame(() => {
    if (hidden) return;
    toast.append(
      el('span', { class: 'resume-toast__icon' }, createIcon([REPLAY_ICON_PATH])),
      el('p', { class: 'resume-toast__text' }, `Fortgesetzt bei ${formatClock(position)}`),
      el('button', { type: 'button', class: 'btn btn-secondary resume-toast__resume', onClick: restartFromZero }, 'Von vorn'),
      el(
        'button',
        { type: 'button', class: 'resume-toast__close', 'aria-label': CLOSE_LABEL, onClick: hide },
        createIcon([CLOSE_ICON_PATH]),
      ),
    );
  });
  restartTimer();

  return { hide };
}
