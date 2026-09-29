import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TARGETS, targetFor, isConvertible, storageKey } from '../../src/convert/targets.js';

test('TARGETS: fixed output shape per target', () => {
  assert.deepEqual(TARGETS.web, { file: 'web.mp4', ext: 'mp4', kind: 'video' });
  assert.deepEqual(TARGETS.flac, { file: 'audio.flac', ext: 'flac', kind: 'audio' });
  assert.deepEqual(TARGETS.opus, { file: 'audio.opus', ext: 'opus', kind: 'audio' });
});

test('targetFor: mid/midi is never convertible, regardless of category or kind', () => {
  assert.equal(targetFor({ category: 'audiobooks', kind: 'audio', ext: 'mid' }), null);
  assert.equal(targetFor({ category: 'music', kind: 'audio', ext: 'midi' }), null);
  assert.equal(targetFor({ category: 'movies', kind: 'video', ext: 'mid' }), null);
});

test('targetFor: kind image is never convertible', () => {
  assert.equal(targetFor({ category: 'images', kind: 'image', ext: 'jpg' }), null);
});

test('targetFor: images category is never convertible, including a gallery video', () => {
  assert.equal(targetFor({ category: 'images', kind: 'image', ext: 'heic' }), null);
  assert.equal(targetFor({ category: 'images', kind: 'video', ext: 'mkv' }), null);
});

test('targetFor: video in movies or series converts to web', () => {
  assert.equal(targetFor({ category: 'movies', kind: 'video', ext: 'mkv' }), 'web');
  assert.equal(targetFor({ category: 'series', kind: 'video', ext: 'avi' }), 'web');
});

test('targetFor: audiobooks always convert to opus', () => {
  assert.equal(targetFor({ category: 'audiobooks', kind: 'audio', ext: 'wma' }), 'opus');
  assert.equal(targetFor({ category: 'audiobooks', kind: 'audio', ext: 'ape' }), 'opus');
  assert.equal(targetFor({ category: 'audiobooks', kind: 'audio', ext: 'mp3' }), 'opus');
});

test('targetFor: lossless-capable music extensions convert to flac', () => {
  for (const ext of ['ape', 'aif', 'aiff', 'wv', 'dsf', 'dff', 'm4a', 'm4b']) {
    assert.equal(targetFor({ category: 'music', kind: 'audio', ext }), 'flac', `${ext} -> flac`);
  }
});

test('targetFor: other music extensions convert to opus', () => {
  for (const ext of ['wma', 'mka', 'ac3', 'dts', 'amr', 'mp3']) {
    assert.equal(targetFor({ category: 'music', kind: 'audio', ext }), 'opus', `${ext} -> opus`);
  }
});

/**
 * @param {Partial<import('../../src/convert/targets.js').TargetInput> & { playable: boolean, size: number }} overrides
 * @returns {import('../../src/db/library-repo.js').LibraryItemRow}
 */
function fakeRow(overrides) {
  return /** @type {import('../../src/db/library-repo.js').LibraryItemRow} */ ({
    category: 'movies',
    kind: 'video',
    ext: 'mkv',
    ...overrides,
  });
}

test('isConvertible: false for size 0, even when otherwise convertible', () => {
  assert.equal(isConvertible(fakeRow({ playable: false, size: 0 })), false);
});

test('isConvertible: false for a playable row', () => {
  assert.equal(isConvertible(fakeRow({ playable: true, size: 100 })), false);
});

test('isConvertible: false when the target mapping is null', () => {
  assert.equal(
    isConvertible(fakeRow({ category: 'images', kind: 'image', ext: 'jpg', playable: false, size: 100 })),
    false,
  );
});

test('isConvertible: true for a non-playable, non-empty, convertible row', () => {
  assert.equal(isConvertible(fakeRow({ playable: false, size: 100 })), true);
});

test('storageKey: 64 lower-case hex characters', () => {
  const key = storageKey('Filme/Beispiel.mkv');
  assert.equal(key.length, 64);
  assert.match(key, /^[0-9a-f]{64}$/);
});

test('storageKey: stable for the same input', () => {
  assert.equal(storageKey('Filme/Beispiel.mkv'), storageKey('Filme/Beispiel.mkv'));
});

test('storageKey: differs for a different path', () => {
  assert.notEqual(storageKey('Filme/Beispiel.mkv'), storageKey('Filme/Anderes.mkv'));
});

test('storageKey: differs for NFC vs NFD spellings of the same visual path', () => {
  const nfc = 'Musik/Café.flac'.normalize('NFC');
  const nfd = 'Musik/Café.flac'.normalize('NFD');
  assert.notEqual(nfc, nfd, 'fixture must actually differ at the byte level');
  assert.notEqual(storageKey(nfc), storageKey(nfd));
});
