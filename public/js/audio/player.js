/**
 * Persistent audio player core: drives one reused `<audio>` element through
 * Phase 4's `trackPlayback`, switching between queue items with a bounded
 * wait for the outgoing item's progress report. See spec-music-audiobooks.md
 * "Player". No DOM access at import time.
 */

import { trackPlayback } from '../lib/progress.js';
import { toLogin } from '../lib/api.js';
import { createQueue } from './queue.js';

/** @typedef {import('./queue.js').QueueItem} QueueItem */
/** @typedef {import('../lib/progress.js').ProgressEntry} ProgressEntry */
/** @typedef {'music' | 'audiobook'} PlayerMode */
/** @typedef {{ item: QueueItem, groupId: number, mode: PlayerMode, playing: boolean, error: string | null }} PlayerState */

/** The minimal `HTMLAudioElement` surface used here, so tests can pass a fake.
 * @typedef {{ src: string, currentTime: number, duration: number, paused: boolean, readyState: number, error: { code: number } | null, play: () => (Promise<void> | undefined), pause: () => void, addEventListener: (type: string, listener: () => void) => void, removeEventListener: (type: string, listener: () => void) => void }} PlayerAudio */

/** @typedef {{ audio: PlayerAudio, track: typeof trackPlayback, headMedia: (id: number) => Promise<number> }} PlayerDeps */

/** @typedef {{ queue: ReturnType<typeof createQueue> | null, mode: PlayerMode | null, groupId: number | null, handle: { stop: () => Promise<void> } | null, playing: boolean, error: string | null, errorTimer: ReturnType<typeof setTimeout> | null, listeners: Set<() => void> }} PlayerInternalState */

const SWITCH_TIMEOUT_MS = 1000;
const ERROR_DISPLAY_MS = 5000;
const ERROR_MESSAGE = 'Titel konnte nicht abgespielt werden';
const MEDIA_ERR_ABORTED = 1;

/**
 * Resolves the HTTP status of a HEAD request for an item's media; `0` on a
 * network error (never rejects).
 * @param {number} id
 * @returns {Promise<number>}
 */
async function defaultHeadMedia(id) {
  try {
    const response = await fetch(`/media/${id}`, { method: 'HEAD', credentials: 'same-origin' });
    return response.status;
  } catch {
    return 0;
  }
}

/**
 * Resolves once `promise` settles or after `ms`, whichever comes first,
 * clearing the timer on the promise branch so a fast `stop()` never leaves a
 * stray timer running.
 * @param {Promise<void>} promise @param {number} ms @returns {Promise<void>}
 */
function raceWithTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** @returns {PlayerInternalState} */
function createState() {
  return { queue: null, mode: null, groupId: null, handle: null, playing: false, error: null, errorTimer: null, listeners: new Set() };
}

/** @param {PlayerInternalState} state @returns {void} */
function notify(state) {
  for (const listener of state.listeners) listener();
}

/**
 * Sets `src`, starts a fresh `trackPlayback` handle and calls `play()` —
 * synchronously when invoked directly from `playQueue`'s first call.
 * @param {PlayerDeps} deps @param {PlayerInternalState} state @param {QueueItem} item @returns {void}
 */
function startItem(deps, state, item) {
  deps.audio.src = `/media/${item.id}`;
  const entry = /** @type {ProgressEntry} */ ({ state: item.start > 0 ? 'in_progress' : 'none', position: item.start });
  state.handle = deps.track(deps.audio, item.id, { entry });
  Promise.resolve(deps.audio.play()).catch(() => {});
  notify(state);
}

/**
 * Switches to `item`: immediately when no handle exists yet (the page's
 * first play), otherwise after the outgoing handle's `stop()` settles,
 * capped at `SWITCH_TIMEOUT_MS` so a slow report never delays auto-advance.
 * @param {PlayerDeps} deps @param {PlayerInternalState} state @param {QueueItem} item @returns {void}
 */
function goTo(deps, state, item) {
  if (state.handle === null) {
    startItem(deps, state, item);
    return;
  }
  const outgoing = state.handle;
  state.handle = null;
  raceWithTimeout(outgoing.stop(), SWITCH_TIMEOUT_MS).then(() => startItem(deps, state, item));
}

/**
 * Shows a transient status message for `ERROR_DISPLAY_MS`.
 * @param {PlayerInternalState} state @param {string} message @returns {void}
 */
function setError(state, message) {
  state.error = message;
  notify(state);
  if (state.errorTimer !== null) clearTimeout(state.errorTimer);
  state.errorTimer = setTimeout(() => {
    state.error = null;
    state.errorTimer = null;
    notify(state);
  }, ERROR_DISPLAY_MS);
}

/** @param {PlayerDeps} deps @param {PlayerInternalState} state @returns {void} */
function onEnded(deps, state) {
  if (state.queue === null) return;
  const item = state.queue.advance();
  if (item !== null) goTo(deps, state, item);
}

/**
 * `code === 1` (`MEDIA_ERR_ABORTED`) is our own `src` swap and is ignored.
 * Otherwise a `HEAD` disambiguates an expired session (→ `toLogin`) from a
 * genuine playback failure (→ status message, then advance).
 * @param {PlayerDeps} deps @param {PlayerInternalState} state @returns {Promise<void>}
 */
async function onError(deps, state) {
  if (deps.audio.error !== null && deps.audio.error.code === MEDIA_ERR_ABORTED) return;
  const item = state.queue ? state.queue.current() : null;
  if (item === null) return;
  const status = await deps.headMedia(item.id);
  if (status === 401) {
    toLogin();
    return;
  }
  setError(state, ERROR_MESSAGE);
  onEnded(deps, state);
}

/** @param {PlayerDeps} deps @param {PlayerInternalState} state @returns {void} */
function attachAudioListeners(deps, state) {
  deps.audio.addEventListener('ended', () => onEnded(deps, state));
  deps.audio.addEventListener('error', () => {
    onError(deps, state);
  });
  deps.audio.addEventListener('play', () => {
    state.playing = true;
    notify(state);
  });
  deps.audio.addEventListener('pause', () => {
    state.playing = false;
    notify(state);
  });
}

/**
 * @param {PlayerDeps} deps @param {PlayerInternalState} state @param {QueueItem[]} items
 * @param {{ startIndex?: number, mode: PlayerMode, groupId: number }} opts @returns {void}
 */
function playQueue(deps, state, items, { startIndex = 0, mode, groupId }) {
  const queue = createQueue(items, { startIndex });
  const item = queue.current();
  if (item === null) return;
  state.queue = queue;
  state.mode = mode;
  state.groupId = groupId;
  notify(state);
  goTo(deps, state, item);
}

/** @param {PlayerDeps} deps @param {PlayerInternalState} state @returns {void} */
function toggle(deps, state) {
  if (state.queue === null) return;
  if (deps.audio.paused) {
    Promise.resolve(deps.audio.play()).catch(() => {});
  } else {
    deps.audio.pause();
  }
}

/** @param {PlayerDeps} deps @param {PlayerInternalState} state @returns {void} */
function next(deps, state) {
  if (state.queue === null) return;
  const item = state.queue.advance();
  if (item !== null) goTo(deps, state, item);
}

/** @param {PlayerDeps} deps @param {PlayerInternalState} state @returns {void} */
function previous(deps, state) {
  if (state.queue === null) return;
  const { item, restart } = state.queue.back(deps.audio.currentTime);
  if (item === null) return;
  if (restart) {
    deps.audio.currentTime = 0;
    notify(state);
    return;
  }
  goTo(deps, state, item);
}

/** @param {PlayerDeps} deps @param {PlayerInternalState} state @param {number} seconds @returns {void} */
function seekBy(deps, state, seconds) {
  seekTo(deps, state, deps.audio.currentTime + seconds);
}

/** @param {PlayerDeps} deps @param {PlayerInternalState} state @param {number} seconds @returns {void} */
function seekTo(deps, state, seconds) {
  if (state.queue === null) return;
  const { audio } = deps;
  const max = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Infinity;
  audio.currentTime = Math.min(Math.max(0, seconds), max);
}

/** @param {PlayerInternalState} state @returns {PlayerState | null} */
function readState(state) {
  const item = state.queue ? state.queue.current() : null;
  if (item === null) return null;
  return {
    item,
    groupId: /** @type {number} */ (state.groupId),
    mode: /** @type {PlayerMode} */ (state.mode),
    playing: state.playing,
    error: state.error,
  };
}

/** @param {PlayerInternalState} state @param {() => void} listener @returns {() => void} */
function onChange(state, listener) {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

/**
 * Creates the persistent audio player driving one reused `<audio>` element.
 * @param {{ audio: PlayerAudio, track?: typeof trackPlayback, headMedia?: (id: number) => Promise<number> }} deps
 * @returns {{
 *   playQueue: (items: QueueItem[], opts: { startIndex?: number, mode: PlayerMode, groupId: number }) => void,
 *   toggle: () => void,
 *   next: () => void,
 *   previous: () => void,
 *   seekBy: (seconds: number) => void,
 *   seekTo: (seconds: number) => void,
 *   state: () => PlayerState | null,
 *   onChange: (listener: () => void) => () => void
 * }}
 */
export function createAudioPlayer({ audio, track = trackPlayback, headMedia = defaultHeadMedia }) {
  const deps = { audio, track, headMedia };
  const state = createState();
  attachAudioListeners(deps, state);
  return {
    playQueue: (items, opts) => playQueue(deps, state, items, opts),
    toggle: () => toggle(deps, state),
    next: () => next(deps, state),
    previous: () => previous(deps, state),
    seekBy: (seconds) => seekBy(deps, state, seconds),
    seekTo: (seconds) => seekTo(deps, state, seconds),
    state: () => readState(state),
    onChange: (listener) => onChange(state, listener),
  };
}
