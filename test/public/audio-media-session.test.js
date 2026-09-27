import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { bindMediaSession } from '../../public/js/audio/media-session.js';

/** @typedef {Parameters<typeof bindMediaSession>[0]} AudioPlayer */

const g = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
/** @type {unknown} */
let savedMetadata;

beforeEach(() => {
  savedMetadata = g.MediaMetadata;
  g.MediaMetadata = class {
    /** @param {Record<string, unknown>} init */
    constructor(init) {
      Object.assign(this, init);
    }
  };
});

afterEach(() => {
  g.MediaMetadata = savedMetadata;
  Reflect.deleteProperty(navigator, 'mediaSession');
});

/**
 * Installs a fake `navigator.mediaSession` whose `setActionHandler` throws a
 * `TypeError` for every action in `unsupported`, like a browser lacking it.
 * @param {string[]} unsupported
 * @returns {{ handlers: Map<string, Function>, session: Record<string, unknown> }}
 */
function installSession(unsupported) {
  const handlers = new Map();
  const session = {
    metadata: null,
    /** @param {string} action @param {Function} handler */
    setActionHandler(action, handler) {
      if (unsupported.includes(action)) throw new TypeError(`unsupported: ${action}`);
      handlers.set(action, handler);
    },
    setPositionState() {},
  };
  Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true });
  return { handlers, session };
}

/** @returns {{ player: AudioPlayer, calls: string[] }} */
function fakePlayer() {
  const calls = /** @type {string[]} */ ([]);
  const player = /** @type {AudioPlayer} */ (/** @type {unknown} */ ({
    state: () => null,
    onChange: () => () => {},
    toggle: () => calls.push('toggle'),
    next: () => calls.push('next'),
    previous: () => calls.push('previous'),
    /** @param {number} s */
    seekBy: (s) => calls.push(`seekBy ${s}`),
    /** @param {number} s */
    seekTo: (s) => calls.push(`seekTo ${s}`),
  }));
  return { player, calls };
}

/** @returns {HTMLAudioElement} */
function fakeAudio() {
  const audio = Object.assign(new EventTarget(), { paused: true, duration: NaN, currentTime: 0, playbackRate: 1 });
  return /** @type {HTMLAudioElement} */ (/** @type {unknown} */ (audio));
}

test('an unsupported action (TypeError) does not stop the other handlers from binding', () => {
  const { handlers } = installSession(['seekbackward', 'seekto']);
  const { player, calls } = fakePlayer();
  assert.doesNotThrow(() => bindMediaSession(player, fakeAudio()));
  assert.deepEqual([...handlers.keys()].sort(), ['nexttrack', 'pause', 'play', 'previoustrack', 'seekforward']);
  handlers.get('seekforward')?.({ action: 'seekforward' });
  handlers.get('nexttrack')?.({ action: 'nexttrack' });
  assert.deepEqual(calls, ['seekBy 30', 'next']);
});

test('every handler binds when all actions are supported', () => {
  const { handlers } = installSession([]);
  const { player, calls } = fakePlayer();
  bindMediaSession(player, fakeAudio());
  assert.equal(handlers.size, 7);
  handlers.get('seekbackward')?.({ action: 'seekbackward' });
  handlers.get('seekto')?.({ action: 'seekto', seekTime: 12 });
  handlers.get('play')?.({ action: 'play' });
  handlers.get('pause')?.({ action: 'pause' });
  assert.deepEqual(calls, ['seekBy -15', 'seekTo 12', 'toggle'], 'pause is a no-op while already paused');
});
