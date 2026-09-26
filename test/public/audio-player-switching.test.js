/**
 * Regression tests for the `goTo` switch race (PR #126 review): overlapping
 * switches must let only the latest requested target actually start, must
 * never mistake a switch arriving mid-wait for the page's first play, and
 * must leave no orphaned handle behind. Split from audio-player.test.js to
 * stay under the constitution's 300-line cap.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAudioPlayer } from '../../public/js/audio/player.js';
import { item, createAudio, createFakeTrack, flush } from '../helpers/audio-player-fakes.js';

/** @type {unknown} */
let savedLocation;
/** @type {typeof fetch | undefined} */
let savedFetch;

beforeEach(() => {
  savedLocation = /** @type {{ location?: unknown }} */ (globalThis).location;
  savedFetch = globalThis.fetch;
});

afterEach(() => {
  /** @type {{ location?: unknown }} */ (globalThis).location = savedLocation;
  globalThis.fetch = /** @type {typeof fetch} */ (savedFetch);
});

test('two quick switches (a double next()) let only the latest target start; the skipped item gets no handle', async () => {
  const { audio } = createAudio();
  const { track, calls, handles } = createFakeTrack();
  const player = createAudioPlayer({ audio, track });
  player.playQueue([item(1), item(2), item(3)], { mode: 'music', groupId: 1 });

  player.next(); // requests item 2, waiting on handles[0].stop()
  player.next(); // requests item 3 before the first switch has settled

  handles[0].resolveStop();
  await flush();

  assert.equal(calls.length, 2, 'item 2 is skipped entirely: only the first play and the final target start');
  assert.equal(audio.src, '/media/3');
  assert.equal(player.state()?.item.id, 3);
  assert.equal(handles.length, 2, 'no handle was ever created for the superseded item 2');
});

test('playQueue() during a pending switch supersedes it: the new queue wins and the old target is skipped', async () => {
  const { audio } = createAudio();
  const { track, calls, handles } = createFakeTrack();
  const player = createAudioPlayer({ audio, track });
  player.playQueue([item(1), item(2)], { mode: 'music', groupId: 1 });

  player.next(); // requests item 2, waiting on handles[0].stop()
  player.playQueue([item(10), item(11)], { mode: 'audiobook', groupId: 99 }); // supersedes it before it settles
  assert.equal(calls.length, 1, 'still waiting: neither the skipped nor the new target has started yet');
  assert.equal(audio.src, '/media/1');

  handles[0].resolveStop();
  await flush();

  assert.equal(calls.length, 2, 'item 2 is skipped: only the first play and the new queue\'s first item start');
  assert.equal(audio.src, '/media/10');
  assert.equal(player.state()?.item.id, 10);
  assert.equal(player.state()?.mode, 'audiobook');
  assert.equal(player.state()?.groupId, 99);
});

test('a stale error HEAD (the user switches away while it is in flight) is dropped, not acted on', async () => {
  const { audio } = createAudio();
  const { track, calls, handles } = createFakeTrack();
  /** @type {(status: number) => void} */
  let resolveHead = () => {};
  const headMedia = /** @type {(id: number) => Promise<number>} */ (
    () => new Promise((resolve) => { resolveHead = resolve; })
  );
  const player = createAudioPlayer({ audio, track, headMedia });
  player.playQueue([item(1), item(2)], { mode: 'music', groupId: 1 });

  audio.error = { code: 2 };
  audio.dispatch('error'); // HEAD for item 1 is now in flight

  player.next(); // the user switches away before the HEAD settles
  handles[0].resolveStop();
  await flush();
  assert.equal(player.state()?.item.id, 2, 'the user\'s own switch completed');
  assert.equal(calls.length, 2);

  resolveHead(500); // the stale HEAD for item 1 settles after the switch
  await flush();
  assert.equal(player.state()?.error, null, 'no status message for an item the user already left');
  assert.equal(player.state()?.item.id, 2, 'no further advance triggered by the stale error');
  assert.equal(calls.length, 2, 'no extra switch beyond the user\'s own next()');
});

test('the default headMedia HEADs /media/:id with credentials same-origin and resolves the response status', async () => {
  const { audio } = createAudio();
  const { track } = createFakeTrack();
  /** @type {{ url: string, init: RequestInit | undefined }[]} */
  const requests = [];
  globalThis.fetch = /** @type {typeof fetch} */ (
    (/** @type {string | URL | Request} */ url, /** @type {RequestInit | undefined} */ init) => {
      requests.push({ url: String(url), init });
      return Promise.resolve(/** @type {Response} */ ({ status: 500 }));
    }
  );
  const player = createAudioPlayer({ audio, track });
  player.playQueue([item(1), item(2)], { mode: 'music', groupId: 1 });
  audio.error = { code: 2 };
  audio.dispatch('error');
  await flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/media/1');
  assert.equal(requests[0].init?.method, 'HEAD');
  assert.equal(requests[0].init?.credentials, 'same-origin');
  assert.equal(player.state()?.error, 'Titel konnte nicht abgespielt werden');
});

test('the default headMedia resolves 0 on a network error, so it advances rather than redirecting', async () => {
  const { audio } = createAudio();
  const { track } = createFakeTrack();
  const assigned = /** @type {string[]} */ ([]);
  /** @type {{ location?: unknown }} */ (globalThis).location = {
    pathname: '/music',
    search: '',
    assign: (/** @type {string} */ u) => assigned.push(u),
  };
  globalThis.fetch = /** @type {typeof fetch} */ (() => Promise.reject(new Error('network down')));
  const player = createAudioPlayer({ audio, track });
  player.playQueue([item(1), item(2)], { mode: 'music', groupId: 1 });
  audio.error = { code: 2 };
  audio.dispatch('error');
  await flush();
  assert.equal(assigned.length, 0, 'a resolved 0 status is not 401: no redirect');
  assert.equal(player.state()?.error, 'Titel konnte nicht abgespielt werden');
});
