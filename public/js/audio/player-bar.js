/**
 * Persistent bottom audio bar: cover, title/subtitle, transport controls,
 * seek slider and a transient error status — driven by the player's state
 * plus the raw `<audio>` element for live position. Owns its own layout
 * spacer (measured via `ResizeObserver`) so the last row of a view is never
 * hidden behind the fixed bar. See spec-music-audiobooks.md "Bar layout".
 */
import { el } from '../lib/dom.js';
import { formatClock } from '../lib/progress.js';
import { audioIcon } from './icons.js';
import { coverImg } from './cover-img.js';
import { formatDuration } from './format.js';
import { trackNavOffset } from './nav-offset.js';

/** @typedef {ReturnType<typeof import('./player.js').createAudioPlayer>} AudioPlayer */
/** @typedef {NonNullable<ReturnType<AudioPlayer['state']>>} PlayerState */

const MIDDLE_DOT = '·';

/**
 * @param {{ player: AudioPlayer, audio: HTMLAudioElement }} deps
 * @returns {{ bar: HTMLElement, spacer: HTMLElement }}
 */
export function createPlayerBar({ player, audio }) {
  const parts = buildBar();
  const spacer = el('div', { class: 'audio-bar-spacer', 'aria-hidden': 'true' });
  let lastItemId = /** @type {number | null} */ (null);
  let dragging = false;

  wireControls(player, parts);
  wireSeek(player, audio, parts, () => dragging, (value) => {
    dragging = value;
  });
  observeHeight(parts.bar, spacer);
  trackNavOffset(parts.bar);

  player.onChange(() => applyState(player.state(), parts, (id) => {
    const changed = id !== lastItemId;
    lastItemId = id;
    return changed;
  }));
  applyState(player.state(), parts, (id) => {
    lastItemId = id;
    return true;
  });

  return { bar: parts.bar, spacer };
}

/** @typedef {ReturnType<typeof buildBar>} BarParts */

/** @returns {{ bar: HTMLElement, cover: HTMLElement, title: HTMLElement, subtitle: HTMLElement, prev: HTMLButtonElement, rewind: HTMLButtonElement, toggle: HTMLButtonElement, forward: HTMLButtonElement, next: HTMLButtonElement, seek: HTMLInputElement, elapsed: HTMLElement, total: HTMLElement, status: HTMLElement }} */
function buildBar() {
  const cover = el('div', { class: 'audio-bar__cover' });
  const title = el('p', { class: 'audio-bar__title' });
  const subtitle = el('p', { class: 'audio-bar__subtitle' });
  const prev = button('audio-bar__prev', 'Vorheriger Titel', audioIcon('previous'));
  const rewind = button('audio-bar__rewind', '15 Sekunden zurück', audioIcon('rewind'), '15');
  const toggle = button('audio-bar__toggle', 'Wiedergabe', audioIcon('play'));
  const forward = button('audio-bar__forward', '30 Sekunden vor', audioIcon('forward'), '30');
  const next = button('audio-bar__next', 'Nächster Titel', audioIcon('next'));
  rewind.hidden = true;
  forward.hidden = true;
  const elapsed = el('span', { class: 'audio-bar__elapsed' }, '0:00');
  const total = el('span', { class: 'audio-bar__total' }, '–:–');
  const seek = /** @type {HTMLInputElement} */ (
    el('input', { type: 'range', class: 'audio-bar__seek-input', 'aria-label': 'Position', min: '0', max: '0', value: '0' })
  );
  const status = el('p', { class: 'audio-bar__status', role: 'status' });
  status.hidden = true;
  const row = el(
    'div',
    { class: 'audio-bar__row' },
    cover,
    el('div', { class: 'audio-bar__meta' }, title, subtitle),
    el('div', { class: 'audio-bar__controls' }, prev, rewind, toggle, forward, next),
  );
  const bar = el(
    'section',
    { class: 'audio-bar', 'aria-label': 'Audioplayer' },
    row,
    el('div', { class: 'audio-bar__seek' }, elapsed, seek, total),
    status,
  );
  bar.hidden = true;
  return { bar, cover, title, subtitle, prev, rewind, toggle, forward, next, seek, elapsed, total, status };
}

/**
 * @param {string} className @param {string} label @param {SVGSVGElement} icon @param {string} [skipLabel]
 * @returns {HTMLButtonElement}
 */
function button(className, label, icon, skipLabel) {
  const children = skipLabel === undefined ? [icon] : [icon, el('span', { class: 'audio-bar__skip-label' }, skipLabel)];
  return /** @type {HTMLButtonElement} */ (el('button', { type: 'button', class: className, 'aria-label': label }, ...children));
}

/**
 * @param {AudioPlayer} player @param {BarParts} parts
 * @returns {void}
 */
function wireControls(player, parts) {
  parts.prev.addEventListener('click', () => player.previous());
  parts.next.addEventListener('click', () => player.next());
  parts.toggle.addEventListener('click', () => player.toggle());
  parts.rewind.addEventListener('click', () => player.seekBy(-15));
  parts.forward.addEventListener('click', () => player.seekBy(30));
}

/**
 * Live position: `timeupdate`/`durationchange` drive the slider and labels
 * while the user is not dragging it; `input` previews the target position,
 * `change` (drag end) commits the seek — avoids fighting the native value
 * on every animation frame while dragging.
 * @param {AudioPlayer} player @param {HTMLAudioElement} audio @param {BarParts} parts
 * @param {() => boolean} isDragging @param {(value: boolean) => void} setDragging
 * @returns {void}
 */
function wireSeek(player, audio, parts, isDragging, setDragging) {
  parts.seek.addEventListener('input', () => {
    setDragging(true);
    parts.elapsed.textContent = formatClock(Number(parts.seek.value));
  });
  parts.seek.addEventListener('change', () => {
    setDragging(false);
    player.seekTo(Number(parts.seek.value));
  });
  parts.seek.addEventListener('pointerup', () => setDragging(false));
  parts.seek.addEventListener('pointercancel', () => setDragging(false));
  audio.addEventListener('timeupdate', () => {
    if (isDragging()) return;
    parts.seek.value = String(audio.currentTime);
    parts.elapsed.textContent = formatClock(audio.currentTime);
  });
  audio.addEventListener('durationchange', () => {
    const known = Number.isFinite(audio.duration) && audio.duration > 0;
    parts.seek.max = known ? String(audio.duration) : '0';
    parts.total.textContent = formatDuration(known ? audio.duration : null);
  });
}

/**
 * @param {HTMLElement} bar @param {HTMLElement} spacer
 * @returns {void}
 */
function observeHeight(bar, spacer) {
  const observer = new ResizeObserver((entries) => {
    const height = entries[0] ? borderBoxHeight(entries[0]) : 0;
    spacer.style.setProperty('height', `${height}px`);
  });
  observer.observe(bar);
}

/**
 * The border-box block size (includes padding/border, unlike `contentRect`);
 * falls back to `contentRect.height` for engines without `borderBoxSize`.
 * @param {ResizeObserverEntry} entry
 * @returns {number}
 */
function borderBoxHeight(entry) {
  const box = entry.borderBoxSize && entry.borderBoxSize[0];
  return box ? box.blockSize : entry.contentRect.height;
}

/**
 * A new item starts from a clean slate: fresh cover, and the previous item's
 * position/duration cleared until the new element's `timeupdate`/
 * `durationchange` report its own (never a stale elapsed label or slider).
 * @param {PlayerState['item']} item @param {PlayerState['mode']} mode @param {BarParts} parts
 * @returns {void}
 */
function resetForItem(item, mode, parts) {
  parts.cover.replaceChildren(coverImg({ coverId: item.coverId, kind: mode === 'music' ? 'album' : 'book' }));
  parts.seek.max = '0';
  parts.seek.value = '0';
  parts.elapsed.textContent = formatClock(0);
  parts.total.textContent = formatDuration(null);
}

/**
 * @param {PlayerState | null} state @param {BarParts} parts @param {(id: number | null) => boolean} itemChanged
 * @returns {void}
 */
function applyState(state, parts, itemChanged) {
  parts.bar.hidden = state === null;
  if (state === null) return;
  const { item, mode, playing, error } = state;
  parts.bar.dataset.mode = mode;
  parts.rewind.hidden = mode !== 'audiobook';
  parts.forward.hidden = mode !== 'audiobook';
  parts.toggle.replaceChildren(audioIcon(playing ? 'pause' : 'play'));
  parts.toggle.setAttribute('aria-label', playing ? 'Pause' : 'Wiedergabe');
  if (itemChanged(item.id)) resetForItem(item, mode, parts);
  parts.title.textContent = item.title;
  parts.subtitle.textContent =
    mode === 'music' ? (item.subtitle ?? '') : [item.groupTitle, item.subtitle].filter((part) => part != null).join(` ${MIDDLE_DOT} `);
  parts.status.hidden = error === null;
  parts.status.textContent = error ?? '';
}
