import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStage } from '../../public/js/lib/player-stage.js';

/**
 * Type-only check, never invoked at runtime: confirms that real DOM
 * elements (as `public/js/player.js` passes them: `createStage(stageEl,
 * video)`) are assignable to `createStage`'s parameter types under this
 * project's strict `checkJs`.
 * @returns {void}
 */
function assertRealDomElementsAreAssignable() {
  /** @type {HTMLElement} */
  const stageEl = document.createElement('div');
  const video = document.createElement('video');
  createStage(stageEl, video);
}

/**
 * Minimal EventTarget-based fake video element exposing only the surface
 * `createStage` is allowed to touch (`remove`, `load`, `play`,
 * `addEventListener`, `currentTime`), plus call counters and a `src` trap
 * so the tests can assert it is never assigned.
 */
class FakeVideo extends EventTarget {
  constructor() {
    super();
    this.loadCalls = 0;
    this.playCalls = 0;
    this.removeCalls = 0;
    this.currentTime = 0;
    this.srcSet = false;
    /** @type {Promise<void> | undefined} */
    this.playResult = undefined;
    Object.defineProperty(this, 'src', {
      set: () => {
        this.srcSet = true;
      },
      get: () => undefined
    });
  }

  /** @returns {void} */
  remove() {
    this.removeCalls += 1;
  }

  /** @returns {void} */
  load() {
    this.loadCalls += 1;
  }

  /** @returns {Promise<void> | undefined} */
  play() {
    this.playCalls += 1;
    return this.playResult;
  }
}

/** Minimal fake stage host exposing only `append`. */
class FakeHost {
  constructor() {
    /** @type {unknown[]} */
    this.appended = [];
  }

  /** @param {unknown} node @returns {void} */
  append(node) {
    this.appended.push(node);
  }
}

/** @returns {Promise<void>} */
function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('detach() removes the video from the stage', () => {
  const host = new FakeHost();
  const video = new FakeVideo();
  const stage = createStage(host, video);

  stage.detach();

  assert.equal(video.removeCalls, 1);
});

test('retry() re-appends the same element, loads once, never assigns src, seeks once on the first loadedmetadata, then plays', async () => {
  const host = new FakeHost();
  const video = new FakeVideo();
  const stage = createStage(host, video);

  stage.retry(42);

  assert.equal(host.appended.length, 1);
  assert.equal(host.appended[0], video, 'must re-append the SAME video object');
  assert.equal(video.loadCalls, 1);
  assert.equal(video.srcSet, false, 'src must never be assigned');
  assert.equal(video.playCalls, 0, 'play must wait for loadedmetadata');

  video.dispatchEvent(new Event('loadedmetadata'));

  assert.equal(video.currentTime, 42);
  assert.equal(video.playCalls, 1);

  // a second loadedmetadata must not re-seek or re-play (listener is once-only)
  video.currentTime = 7;
  video.dispatchEvent(new Event('loadedmetadata'));

  assert.equal(video.currentTime, 7);
  assert.equal(video.playCalls, 1);
  await flushMicrotasks();
});

test('retry(0) does not seek but still plays once metadata is loaded', () => {
  const host = new FakeHost();
  const video = new FakeVideo();
  video.currentTime = 5;
  const stage = createStage(host, video);

  stage.retry(0);
  video.dispatchEvent(new Event('loadedmetadata'));

  assert.equal(video.currentTime, 5, 'position 0 means no seek');
  assert.equal(video.playCalls, 1);
});

test('a rejected play() promise is swallowed', async () => {
  const host = new FakeHost();
  const video = new FakeVideo();
  video.playResult = Promise.reject(new Error('boom'));
  const stage = createStage(host, video);

  let unhandledRejectionFired = false;
  /** @returns {void} */
  const onUnhandledRejection = () => {
    unhandledRejectionFired = true;
  };
  process.once('unhandledRejection', onUnhandledRejection);

  stage.retry(10);
  video.dispatchEvent(new Event('loadedmetadata'));

  await flushMicrotasks();
  process.removeListener('unhandledRejection', onUnhandledRejection);

  assert.equal(video.playCalls, 1);
  assert.equal(
    unhandledRejectionFired,
    false,
    'the rejected play() promise must be caught, never surface as an unhandled rejection'
  );
});
