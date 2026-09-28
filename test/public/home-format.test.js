import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  listenHref,
  listenFraction,
  listenProgressText,
  listenMeta,
  PREVIEW_SECTIONS,
  previewCountLabel,
  albumCardText,
  bookCardText,
} from '../../public/js/lib/home-format.js';
import { NAV_ENTRIES } from '../../public/js/lib/nav.js';

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

test('PREVIEW_SECTIONS is in nav order with labels matching NAV_ENTRIES and the documented hrefs', () => {
  assert.deepEqual(
    PREVIEW_SECTIONS.map((s) => s.category),
    ['movies', 'series', 'music', 'audiobooks', 'images'],
  );
  for (const section of PREVIEW_SECTIONS) {
    const navEntry = NAV_ENTRIES.find((n) => n.id === section.category);
    assert.equal(section.label, navEntry?.label, `label for ${section.category}`);
  }
  assert.deepEqual(
    PREVIEW_SECTIONS.map((s) => s.allHref),
    ['/movies?sort=added', '/series?sort=added', '/music', '/audiobooks', '/images'],
  );
});

test('previewCountLabel uses the singular/plural word per category', () => {
  assert.equal(previewCountLabel('movies', 0), '0 Titel');
  assert.equal(previewCountLabel('movies', 1), '1 Titel');
  assert.equal(previewCountLabel('movies', 2), '2 Titel');
  assert.equal(previewCountLabel('series', 1), '1 Serie');
  assert.equal(previewCountLabel('series', 2), '2 Serien');
  assert.equal(previewCountLabel('music', 1), '1 Album');
  assert.equal(previewCountLabel('music', 2), '2 Alben');
  assert.equal(previewCountLabel('audiobooks', 1), '1 Hörbuch');
  assert.equal(previewCountLabel('audiobooks', 2), '2 Hörbücher');
  assert.equal(previewCountLabel('images', 1), '1 Datei');
  assert.equal(previewCountLabel('images', 2), '2 Dateien');
});

test('albumCardText falls back for an untitled album and an unknown artist', () => {
  assert.deepEqual(
    albumCardText({ id: 6, title: 'Unterwegs', artist: 'Die Beispiele', year: null, coverId: 6, trackCount: 10 }),
    { href: '/music?album=6', title: 'Unterwegs', meta: 'Die Beispiele' },
  );
  assert.deepEqual(
    albumCardText({ id: 6, title: null, artist: null, year: null, coverId: 6, trackCount: 1 }),
    { href: '/music?album=6', title: 'Einzeltitel', meta: 'Unbekannter Interpret' },
  );
});

test('bookCardText falls back for an unknown author', () => {
  assert.deepEqual(
    bookCardText({ id: 41, title: 'Die Reise', author: null, coverId: 41, fileCount: 3, duration: 3600 }),
    { href: '/audiobooks?book=41', title: 'Die Reise', meta: 'Unbekannter Autor' },
  );
});
