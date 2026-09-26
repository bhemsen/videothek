import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAudioPlayer } from '../../public/js/audio/player.js';
import { item, createAudio, createFakeTrack, flush } from '../helpers/audio-player-fakes.js';

/** @type {unknown} */
let savedLocation;

beforeEach(() => {
  savedLocation = /** @type {{ location?: unknown }} */ (globalThis).location;
});

afterEach(() => {
  /** @type {{ location?: unknown }} */ (globalThis).location = savedLocation;
});

test('the first playQueue calls play() synchronously with the entry normalised from `start`', () => {
  const { audio, playCalls } = createAudio();
  const { track, calls } = createFakeTrack();
  const player = createAudioPlayer({ audio, track });
  player.playQueue([item(1, true, 42), item(2)], { mode: 'music', groupId: 10 });
  assert.equal(playCalls.length, 1, 'play() called synchronously, no await needed');
  assert.equal(audio.src, '/media/1');
  assert.deepEqual(calls[0], { itemId: 1, entry: { state: 'in_progress', position: 42 } });
  assert.equal(player.state()?.item.id, 1);
  assert.equal(player.state()?.mode, 'music');
  assert.equal(player.state()?.groupId, 10);
});

test('a start of 0 normalises to state none', () => {
  const { audio } = createAudio();
  const { track, calls } = createFakeTrack();
  const player = createAudioPlayer({ audio, track });
  player.playQueue([item(1, true, 0)], { mode: 'audiobook', groupId: 1 });
  assert.deepEqual(calls[0].entry, { state: 'none', position: 0 });
});

test('a later switch waits for the outgoing stop() before switching', async () => {
  const { audio, playCalls } = createAudio();
  const { track, calls, handles } = createFakeTrack();
  const player = createAudioPlayer({ audio, track });
  player.playQueue([item(1), item(2)], { mode: 'music', groupId: 1 });

  player.next();
  await flush();
  assert.equal(calls.length, 1, 'the next item has not started yet: stop() is still pending');
  assert.equal(audio.src, '/media/1');

  handles[0].resolveStop();
  await flush();
  assert.equal(calls.length, 2);
  assert.equal(audio.src, '/media/2');
  assert.equal(playCalls.length, 2);
  assert.equal(handles[0].stopCalls, 1, 'the outgoing handle is stopped exactly once');
});

test('a never-resolving stop() still switches after 1 s, and the old handle gets no further calls', async (t) => {
  const { audio } = createAudio();
  const { track, calls, handles } = createFakeTrack();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const player = createAudioPlayer({ audio, track });
  player.playQueue([item(1), item(2)], { mode: 'music', groupId: 1 });

  player.next();
  t.mock.timers.tick(999);
  await flush();
  assert.equal(calls.length, 1, 'still capped, not switched before 1 s');

  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls.length, 2, 'switched once the 1 s cap is reached');
  assert.equal(audio.src, '/media/2');
  assert.equal(handles[0].stopCalls, 1, 'no repeat or further call on the old handle');
});

test('previous() within 3 s moves to the previous item; past 3 s it restarts the current one', async () => {
  const { audio } = createAudio();
  const { track, handles } = createFakeTrack();
  const player = createAudioPlayer({ audio, track });
  player.playQueue([item(1), item(2)], { mode: 'music', groupId: 1 });
  player.next();
  handles[0].resolveStop();
  await flush();
  assert.equal(player.state()?.item.id, 2);

  audio.currentTime = 5;
  player.previous();
  await flush();
  assert.equal(audio.currentTime, 0, 'restart seeks to 0 without switching items');
  assert.equal(player.state()?.item.id, 2);

  audio.currentTime = 1;
  player.previous();
  handles[1].resolveStop();
  await flush();
  assert.equal(player.state()?.item.id, 1, 'moved to the previous item');
});

test('an error event with code 1 (our own src swap) is ignored', async () => {
  const { audio } = createAudio();
  const { track } = createFakeTrack();
  let headCalls = 0;
  const player = createAudioPlayer({ audio, track, headMedia: async () => { headCalls += 1; return 0; } });
  player.playQueue([item(1), item(2)], { mode: 'music', groupId: 1 });
  audio.error = { code: 1 };
  audio.dispatch('error');
  await flush();
  assert.equal(headCalls, 0);
  assert.equal(player.state()?.error, null);
});

test('a real error whose HEAD is 401 redirects to login without a status message', async () => {
  const { audio } = createAudio();
  const { track, calls } = createFakeTrack();
  const assigned = /** @type {string[]} */ ([]);
  /** @type {{ location?: unknown }} */ (globalThis).location = {
    pathname: '/music',
    search: '',
    assign: (/** @type {string} */ u) => assigned.push(u),
  };
  const player = createAudioPlayer({ audio, track, headMedia: async () => 401 });
  player.playQueue([item(1), item(2)], { mode: 'music', groupId: 1 });
  audio.error = { code: 2 };
  audio.dispatch('error');
  await flush();
  assert.equal(assigned.length, 1);
  assert.match(assigned[0], /^\/login\?next=/);
  assert.equal(player.state()?.error, null);
  assert.equal(calls.length, 1, 'no advance on a 401');
});

test('a real error with a non-401 HEAD shows a status message and advances', async () => {
  const { audio } = createAudio();
  const { track, calls, handles } = createFakeTrack();
  const player = createAudioPlayer({ audio, track, headMedia: async () => 500 });
  player.playQueue([item(1), item(2)], { mode: 'music', groupId: 1 });
  audio.error = { code: 2 };
  audio.dispatch('error');
  handles[0].resolveStop();
  await flush();
  assert.equal(player.state()?.error, 'Titel konnte nicht abgespielt werden');
  assert.equal(player.state()?.item.id, 2);
  assert.equal(calls.length, 2);
});

test('toggle() plays when paused and pauses when playing; play/pause events update state().playing', () => {
  const { audio } = createAudio();
  const { track } = createFakeTrack();
  const player = createAudioPlayer({ audio, track });
  player.playQueue([item(1)], { mode: 'music', groupId: 1 });
  audio.dispatch('play');
  assert.equal(player.state()?.playing, true);
  player.toggle();
  assert.equal(audio.paused, true);
  audio.dispatch('pause');
  assert.equal(player.state()?.playing, false);
});

test('seekTo clamps to [0, duration] and seekBy applies a relative offset', () => {
  const { audio } = createAudio();
  const { track } = createFakeTrack();
  const player = createAudioPlayer({ audio, track });
  player.playQueue([item(1)], { mode: 'music', groupId: 1 });
  player.seekTo(-5);
  assert.equal(audio.currentTime, 0);
  player.seekTo(5000);
  assert.equal(audio.currentTime, 1000);
  audio.currentTime = 100;
  player.seekBy(-15);
  assert.equal(audio.currentTime, 85);
});

test('onChange notifies on state transitions and unsubscribes', () => {
  const { audio } = createAudio();
  const { track } = createFakeTrack();
  const player = createAudioPlayer({ audio, track });
  let calls = 0;
  const unsubscribe = player.onChange(() => { calls += 1; });
  player.playQueue([item(1)], { mode: 'music', groupId: 1 });
  assert.ok(calls > 0);
  unsubscribe();
  const before = calls;
  audio.dispatch('play');
  assert.equal(calls, before, 'no further notifications after unsubscribe');
});

test('state() is null before any queue has played', () => {
  const { audio } = createAudio();
  const { track } = createFakeTrack();
  const player = createAudioPlayer({ audio, track });
  assert.equal(player.state(), null);
});
