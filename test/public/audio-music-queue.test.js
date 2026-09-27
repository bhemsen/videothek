import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAlbumQueue,
  resumeStartIndex,
  activeTrackId,
  trackListEntries,
  UNKNOWN_ARTIST,
  UNTITLED_ALBUM,
} from '../../public/js/audio/music-queue.js';

/** @typedef {import('../../public/js/audio/audio-api.js').AlbumDetail} AlbumDetail */
/** @typedef {import('../../public/js/audio/audio-api.js').AlbumTrack} AlbumTrack */

/**
 * @param {Partial<AlbumTrack> & { id: number }} overrides
 * @returns {AlbumTrack}
 */
function track(overrides) {
  return { title: `Titel ${overrides.id}`, artist: 'Die Beispiele', trackNo: overrides.id, discNo: 1, duration: 120, playable: true, ext: '.mp3', ...overrides };
}

/**
 * @param {Partial<AlbumDetail>} [overrides]
 * @returns {AlbumDetail}
 */
function album(overrides = {}) {
  return {
    id: 7,
    title: 'Unterwegs',
    artist: 'Die Beispiele',
    year: 2019,
    coverId: 11,
    duration: 360,
    discCount: 1,
    tracks: [track({ id: 1 }), track({ id: 2 }), track({ id: 3 })],
    ...overrides,
  };
}

test('buildAlbumQueue follows the #72 QueueItem convention: subtitle = track artist, groupTitle = album title', () => {
  const [first] = buildAlbumQueue(album());
  assert.deepEqual(first, {
    id: 1,
    title: 'Titel 1',
    subtitle: 'Die Beispiele',
    groupTitle: 'Unterwegs',
    coverId: 11,
    duration: 120,
    playable: true,
    start: 0,
  });
});

test('buildAlbumQueue: a pseudo-album (title null) gets "Einzeltitel", an untagged track "Unbekannter Interpret"', () => {
  const items = buildAlbumQueue(album({ title: null, tracks: [track({ id: 4, artist: null })] }));
  assert.equal(items[0].groupTitle, UNTITLED_ALBUM);
  assert.equal(items[0].subtitle, UNKNOWN_ARTIST);
  assert.ok(items.every((item) => item.groupTitle !== null), 'groupTitle is never null for a music item');
});

test('buildAlbumQueue without resume starts every track at 0 (track click / "Alle abspielen")', () => {
  assert.deepEqual(buildAlbumQueue(album()).map((item) => item.start), [0, 0, 0]);
});

test('buildAlbumQueue with resume starts only the resumed track at its position, the rest at 0', () => {
  const items = buildAlbumQueue(album(), { trackId: 2, position: 40 });
  assert.deepEqual(items.map((item) => item.start), [0, 40, 0]);
});

test('buildAlbumQueue keeps non-playable tracks with playable: false (the queue filters them)', () => {
  const items = buildAlbumQueue(album({ tracks: [track({ id: 1 }), track({ id: 2, playable: false, ext: '.wma' })] }));
  assert.deepEqual(items.map((item) => item.playable), [true, false]);
});

test('resumeStartIndex finds the resumed track, and falls back to 0 for a non-member', () => {
  assert.equal(resumeStartIndex(album(), 3), 2);
  assert.equal(resumeStartIndex(album(), 99), 0);
});

test('activeTrackId is keyed by (mode, groupId, item.id)', () => {
  const state = { item: { id: 2 }, groupId: 7, mode: 'music' };
  assert.equal(activeTrackId(state, 7), 2);
  assert.equal(activeTrackId(state, 8), null, 'another album is playing');
  assert.equal(activeTrackId({ ...state, mode: 'audiobook' }, 7), null, 'an audiobook with the same group id');
  assert.equal(activeTrackId(null, 7), null, 'nothing playing');
});

test('trackListEntries adds no disc headings for a single-disc album', () => {
  const entries = trackListEntries(album());
  assert.equal(entries.some((entry) => entry.kind === 'disc'), false);
  assert.deepEqual(entries.map((entry) => (entry.kind === 'track' ? entry.index : -1)), [0, 1, 2]);
});

test('trackListEntries adds a "CD n" heading before each disc only when discCount > 1', () => {
  const tracks = [track({ id: 1, discNo: 1 }), track({ id: 2, discNo: 1 }), track({ id: 3, discNo: 2 })];
  const entries = trackListEntries(album({ discCount: 2, tracks }));
  assert.deepEqual(
    entries.map((entry) => (entry.kind === 'disc' ? `CD ${entry.discNo}` : entry.track.id)),
    ['CD 1', 1, 2, 'CD 2', 3],
  );
  const indexes = entries.flatMap((entry) => (entry.kind === 'track' ? [entry.index] : []));
  assert.deepEqual(indexes, [0, 1, 2], 'indexes address album.tracks, unaffected by headings');
});
