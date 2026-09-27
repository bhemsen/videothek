/**
 * Shared fakes for `public/js/audio/player.js` tests: a queue item builder,
 * a fake `EventTarget`-based `<audio>` element and a fake `trackPlayback`
 * whose handles expose a controllable `stop()`. Split out so the audio
 * player test files stay under the constitution's 300-line cap.
 */

/** @typedef {import('../../public/js/audio/queue.js').QueueItem} QueueItem */
/** @typedef {import('../../public/js/lib/progress.js').TrackedMedia} TrackedMedia */
/** @typedef {import('../../public/js/lib/progress.js').TrackPlaybackOptions} TrackPlaybackOptions */

/** @param {number} id @param {boolean} [playable] @param {number} [start] @returns {QueueItem} */
export function item(id, playable = true, start = 0) {
  return { id, title: `Track ${id}`, subtitle: null, groupTitle: null, coverId: null, duration: 100, playable, start };
}

/** A fake `EventTarget` exposing a synchronous `dispatch` for tests. */
function createTarget() {
  /** @type {Map<string, Set<() => void>>} */
  const listeners = new Map();
  return {
    addEventListener(/** @type {string} */ type, /** @type {() => void} */ fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(fn);
    },
    removeEventListener(/** @type {string} */ type, /** @type {() => void} */ fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(/** @type {string} */ type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
  };
}

/** A fake `<audio>` element: `play`/`pause` are spies, `error` is settable before dispatching `error`. */
export function createAudio() {
  const target = createTarget();
  const playCalls = /** @type {string[]} */ ([]);
  const audio = {
    ...target,
    src: '',
    currentTime: 0,
    duration: 1000,
    paused: true,
    readyState: 1,
    error: /** @type {{ code: number } | null} */ (null),
    play() {
      playCalls.push(audio.src);
      audio.paused = false;
      return Promise.resolve();
    },
    pause() {
      audio.paused = true;
    },
  };
  return { audio, playCalls };
}

/** A fake `trackPlayback`: each call gets its own controllable `stop()` deferred. */
export function createFakeTrack() {
  const calls = /** @type {{ itemId: number, entry: unknown }[]} */ ([]);
  /** @type {{ itemId: number, stopCalls: number, resolveStop: () => void, stop: () => Promise<void> }[]} */
  const handles = [];
  /** @param {TrackedMedia} _media @param {number} itemId @param {TrackPlaybackOptions} [opts] */
  function track(_media, itemId, opts) {
    /** @type {() => void} */
    let resolveStop = () => {};
    const promise = /** @type {Promise<void>} */ (
      new Promise((resolve) => {
        resolveStop = /** @type {() => void} */ (resolve);
      })
    );
    const handle = { itemId, stopCalls: 0, resolveStop, stop: () => { handle.stopCalls += 1; return promise; } };
    calls.push({ itemId, entry: opts?.entry });
    handles.push(handle);
    return handle;
  }
  return { track, calls, handles };
}

/** Flushes pending microtasks without touching mocked timers. */
export function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}
