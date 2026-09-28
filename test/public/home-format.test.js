import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listenHref, listenFraction, listenProgressText, listenMeta } from '../../public/js/lib/home-format.js';

/** @returns {import('../../public/js/lib/home-api.js').MusicListeningItem} */
function musicItem(overrides = {}) {
  return {
    kind: 'music',
    trackId: 7,
    albumId: 6,
    title: 'Titel',
    artist: 'Die Beispiele',
    albumTitle: 'Unterwegs',
    coverId: 6,
    position: 60,
    duration: 240,
    updatedAt: '2026-09-27T20:00:00.000Z',
    ...overrides,
  };
}

/** @returns {import('../../public/js/lib/home-api.js').AudiobookListeningItem} */
function audiobookItem(overrides = {}) {
  return {
    kind: 'audiobook',
    id: 41,
    title: 'Die Reise',
    author: 'Jules Beispiel',
    coverId: 41,
    fraction: 0.5,
    remaining: 180,
    updatedAt: '2026-09-28T10:00:00.000Z',
    resume: { itemId: 42, position: 0, fileTitle: 'Teil 2' },
    ...overrides,
  };
}

test('listenHref links a music item to /music and an audiobook to its book page', () => {
  assert.equal(listenHref(musicItem()), '/music');
  assert.equal(listenHref(audiobookItem({ id: 41 })), '/audiobooks?book=41');
});

test('listenFraction derives and clamps the 0..1 fraction', () => {
  assert.equal(listenFraction(musicItem({ position: 60, duration: 240 })), 0.25);
  assert.equal(listenFraction(musicItem({ duration: null })), 0);
  assert.equal(listenFraction(musicItem({ position: 300, duration: 240 })), 1);
  assert.equal(listenFraction(audiobookItem({ fraction: null })), 0);
  assert.equal(listenFraction(audiobookItem({ fraction: 0.5 })), 0.5);
});

test('listenProgressText rounds the percentage', () => {
  assert.equal(listenProgressText(musicItem({ position: 254, duration: 1000 })), 'Zu 25 % gehört');
});

test('listenMeta joins artist/file title with the remaining time', () => {
  assert.equal(
    listenMeta(musicItem({ artist: 'Die Beispiele', position: 60, duration: 240 })),
    'Die Beispiele · Noch 3 Min.',
  );
  assert.equal(
    listenMeta(musicItem({ artist: null, position: 60, duration: 240 })),
    'Unbekannter Interpret · Noch 3 Min.',
  );
  assert.equal(listenMeta(musicItem({ artist: 'Die Beispiele', duration: null })), 'Die Beispiele');
  assert.equal(
    listenMeta(audiobookItem({ resume: { itemId: 1, position: 0, fileTitle: 'Teil 2' }, remaining: 180 })),
    'Teil 2 · Noch 3 Min.',
  );
  assert.equal(
    listenMeta(audiobookItem({ resume: { itemId: 1, position: 0, fileTitle: 'Teil 2' }, remaining: null })),
    'Teil 2',
  );
  assert.equal(
    listenMeta(audiobookItem({ resume: { itemId: 1, position: 0, fileTitle: '' }, remaining: 180 })),
    'Noch 3 Min.',
  );
});
