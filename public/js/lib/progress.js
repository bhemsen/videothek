/**
 * Media-element-agnostic playback progress client: API wrappers, the
 * `trackPlayback` reporter/resumer and time formatters. Reused unchanged by
 * the audio player (Phase 5). No DOM/`window` access at import time.
 */

import { request } from './api.js';

/** @typedef {{ itemId: number, position: number, duration: number | null, state: 'none' | 'in_progress' | 'finished' | 'next_up', updatedAt: string | null, item?: unknown }} ProgressEntry */

/** The minimal `HTMLMediaElement` surface `trackPlayback` uses, so a fake media element in tests needs no full DOM implementation.
 * @typedef {{ readyState: number, duration: number, currentTime: number, addEventListener: (type: string, listener: () => void) => void, removeEventListener: (type: string, listener: () => void) => void }} TrackedMedia */

/** @typedef {{ entry?: ProgressEntry, onResume?: (position: number) => void, resume?: boolean }} TrackPlaybackOptions */

/** @typedef {{ needsResume: boolean, seekIssued: boolean, resumeSettled: boolean, armed: boolean, onResumeCalled: boolean, lastSent: number, intervalId: ReturnType<typeof setInterval> | null, stopped: boolean, stopPromise: Promise<void> | null }} TrackerState */

/** @typedef {{ metadata: () => void, seeked: () => void, playing: () => void, reportAndStop: () => void, emptied: () => void, stopIntervalOnly: () => void, visibility: () => void, report: () => void }} TrackerHandlers */

const HAVE_METADATA = 1; // HTMLMediaElement.HAVE_METADATA, inlined so tests need no DOM constants
const REPORT_INTERVAL_MS = 10_000;

/**
 * Fetches the stored progress for an item.
 * @param {number} itemId
 * @returns {Promise<ProgressEntry>}
 */
export async function getProgress(itemId) {
  const { data } = await request('GET', `/api/progress/${itemId}`);
  return /** @type {ProgressEntry} */ (data);
}

/**
 * Reports a playback position: a keepalive `PUT` that never redirects on
 * `401`, used for every report incl. `pagehide` — never `sendBeacon` (it
 * cannot send a JSON body).
 * @param {number} itemId
 * @param {{ position: number, duration: number }} payload
 * @returns {Promise<ProgressEntry>}
 */
export async function saveProgress(itemId, { position, duration }) {
  const { data } = await request('PUT', `/api/progress/${itemId}`, {
    json: { position, duration },
    keepalive: true,
    redirectOn401: false,
  });
  return /** @type {ProgressEntry} */ (data);
}

/**
 * Resets an item's progress to `none`.
 * @param {number} itemId
 * @returns {Promise<void>}
 */
export async function removeProgress(itemId) {
  await request('DELETE', `/api/progress/${itemId}`);
}

/**
 * Lists progress entries.
 * @param {{ category?: string | string[], view?: string, limit?: number }} [params]
 * @returns {Promise<ProgressEntry[]>}
 */
export async function listProgress({ category, view, limit } = {}) {
  const query = new URLSearchParams();
  if (category !== undefined) query.set('category', Array.isArray(category) ? category.join(',') : category);
  if (view !== undefined) query.set('view', view);
  if (limit !== undefined) query.set('limit', String(limit));
  const qs = query.toString();
  const { data } = await request('GET', qs ? `/api/progress?${qs}` : '/api/progress');
  return /** @type {{ items: ProgressEntry[] }} */ (data).items;
}

/**
 * Formats seconds as a clock: `12:34` under an hour, `1:02:03` from an hour on.
 * @param {number} seconds
 * @returns {string}
 */
export function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${secs}` : `${minutes}:${secs}`;
}

/**
 * Formats remaining seconds, e.g. "Noch 24 Min." / "Noch 1 Std. 52 Min." /
 * "Noch 2 Std." (minutes rounded up, minimum 1, a zero minute part omitted).
 * @param {number} seconds
 * @returns {string}
 */
export function formatRemaining(seconds) {
  const totalMinutes = Math.max(1, Math.ceil(seconds / 60));
  if (totalMinutes < 60) return `Noch ${totalMinutes} Min.`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `Noch ${hours} Std.` : `Noch ${hours} Std. ${minutes} Min.`;
}

/**
 * Attaches a resume + periodic-report tracker to a media element. A failed
 * initial fetch (when `entry` is omitted) counts as state `none`.
 * @param {TrackedMedia} media
 * @param {number} itemId
 * @param {TrackPlaybackOptions} [opts]
 * @returns {Promise<{ stop: () => Promise<void> }>}
 */
export async function trackPlayback(media, itemId, opts = {}) {
  const { onResume, resume = true } = opts;
  const entry = opts.entry !== undefined ? opts.entry : await fetchEntryOrNone(itemId);
  return attachTracker(media, itemId, entry, onResume, resume);
}

/** @param {number} itemId @returns {Promise<ProgressEntry>} */
async function fetchEntryOrNone(itemId) {
  try {
    return await getProgress(itemId);
  } catch {
    return { itemId, position: 0, duration: null, state: 'none', updatedAt: null };
  }
}

/** @param {ProgressEntry} entry @param {boolean} resume @returns {TrackerState} */
function createTrackerState(entry, resume) {
  const needsResume = resume && entry.state === 'in_progress' && entry.position > 0;
  return {
    needsResume,
    seekIssued: false,
    resumeSettled: false,
    armed: false,
    onResumeCalled: false,
    lastSent: needsResume ? entry.position : 0,
    intervalId: null,
    stopped: false,
    stopPromise: null,
  };
}

/**
 * @param {TrackedMedia} media @param {number} itemId @param {ProgressEntry} entry
 * @param {((position: number) => void) | undefined} onResume @param {boolean} resume
 * @returns {{ stop: () => Promise<void> }}
 */
function attachTracker(media, itemId, entry, onResume, resume) {
  const state = createTrackerState(entry, resume);
  const report = () => sendReport(media, itemId, state);
  /** @type {TrackerHandlers} */
  const handlers = {
    metadata: () => onMetadata(media, entry, state),
    seeked: () => onSeeked(entry, onResume, state, () => armIfReady(media, state)),
    playing: () => {
      armIfReady(media, state);
      startInterval(state, report);
    },
    reportAndStop: () => {
      stopInterval(state);
      report();
    },
    emptied: () => onEmptied(state),
    stopIntervalOnly: () => stopInterval(state),
    visibility: () => {
      if (document.visibilityState === 'hidden') report();
    },
    report,
  };
  const listeners = listenerTable(media, handlers);
  for (const [target, type, fn] of listeners) target.addEventListener(type, fn);
  if (media.readyState >= HAVE_METADATA) handlers.metadata();
  return { stop: () => stopTracker(listeners, state, report) };
}

/**
 * @param {TrackedMedia} media @param {TrackerHandlers} h
 * @returns {[Pick<TrackedMedia, 'addEventListener' | 'removeEventListener'>, string, () => void][]}
 */
function listenerTable(media, h) {
  return [
    [media, 'loadedmetadata', h.metadata],
    [media, 'seeked', h.seeked],
    [media, 'playing', h.playing],
    [media, 'pause', h.reportAndStop],
    [media, 'ended', h.reportAndStop],
    [media, 'emptied', h.emptied],
    [media, 'error', h.stopIntervalOnly],
    [document, 'visibilitychange', h.visibility],
    [window, 'pagehide', h.report],
  ];
}

/** @param {TrackedMedia} media @param {ProgressEntry} entry @param {TrackerState} state @returns {void} */
function onMetadata(media, entry, state) {
  if (!state.needsResume) {
    armIfReady(media, state);
    return;
  }
  if (state.resumeSettled || state.seekIssued) return;
  if (entry.position >= media.duration) {
    state.needsResume = false;
    armIfReady(media, state);
    return;
  }
  state.seekIssued = true;
  media.currentTime = entry.position;
}

/**
 * @param {ProgressEntry} entry @param {((position: number) => void) | undefined} onResume
 * @param {TrackerState} state @param {() => void} maybeArm @returns {void}
 */
function onSeeked(entry, onResume, state, maybeArm) {
  if (!state.needsResume || !state.seekIssued) return;
  if (!state.onResumeCalled) {
    state.onResumeCalled = true;
    onResume?.(entry.position);
  }
  maybeArm();
}

// `emptied` disarms reporting until the next `playing`; a resume seek that
// had not landed yet is repeated on the next `loadedmetadata`.
/** @param {TrackerState} state @returns {void} */
function onEmptied(state) {
  state.armed = false;
  stopInterval(state);
  if (state.needsResume && !state.resumeSettled) state.seekIssued = false;
}

/** @param {TrackedMedia} media @param {TrackerState} state @returns {void} */
function armIfReady(media, state) {
  if (state.armed) return;
  if (state.needsResume && !state.seekIssued) return;
  if (!Number.isFinite(media.duration) || media.duration <= 0) return;
  state.armed = true;
  if (state.needsResume) state.resumeSettled = true;
}

/** @param {TrackerState} state @param {() => void} report @returns {void} */
function startInterval(state, report) {
  stopInterval(state);
  state.intervalId = setInterval(report, REPORT_INTERVAL_MS);
}

/** @param {TrackerState} state @returns {void} */
function stopInterval(state) {
  if (state.intervalId === null) return;
  clearInterval(state.intervalId);
  state.intervalId = null;
}

// Skips a report when disarmed, the duration is unknown, or the move since
// the last sent position is under 1 s. A failed report is dropped with a
// warning and never advances `lastSent`, so the next trigger retries.
/** @param {TrackedMedia} media @param {number} itemId @param {TrackerState} state @returns {Promise<void>} */
async function sendReport(media, itemId, state) {
  if (!state.armed) return;
  if (!Number.isFinite(media.duration) || media.duration <= 0) return;
  const position = media.currentTime;
  if (Math.abs(position - state.lastSent) < 1) return;
  try {
    await saveProgress(itemId, { position, duration: media.duration });
    state.lastSent = position;
  } catch (err) {
    console.warn('progress report failed', err);
  }
}

/**
 * @param {[Pick<TrackedMedia, 'removeEventListener'>, string, () => void][]} listeners
 * @param {TrackerState} state @param {() => Promise<void>} report @returns {Promise<void>}
 */
function stopTracker(listeners, state, report) {
  if (state.stopped) return /** @type {Promise<void>} */ (state.stopPromise);
  state.stopped = true;
  stopInterval(state);
  for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
  state.stopPromise = report();
  return state.stopPromise;
}
