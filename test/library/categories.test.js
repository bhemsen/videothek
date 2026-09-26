import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATEGORIES, categoryForFolder, kindsFor } from '../../src/library/categories.js';

test('CATEGORIES lists all five ids in nav order', () => {
  assert.deepEqual(CATEGORIES, ['movies', 'series', 'music', 'audiobooks', 'images']);
});

const ALIASES = [
  ['Filme', 'movies'],
  ['FILME', 'movies'],
  ['Movies', 'movies'],
  ['movies', 'movies'],
  ['Serien', 'series'],
  ['SERIEN', 'series'],
  ['Series', 'series'],
  ['TV', 'series'],
  ['tv', 'series'],
  ['Musik', 'music'],
  ['MUSIK', 'music'],
  ['Music', 'music'],
  ['Hörbücher', 'audiobooks'],
  ['HÖRBÜCHER', 'audiobooks'],
  ['Hoerbuecher', 'audiobooks'],
  ['HOERBUECHER', 'audiobooks'],
  ['Audiobooks', 'audiobooks'],
  ['Bilder', 'images'],
  ['BILDER', 'images'],
  ['Pictures', 'images'],
  ['Photos', 'images']
];

for (const [folder, expected] of ALIASES) {
  test(`categoryForFolder maps "${folder}" -> ${expected}`, () => {
    assert.equal(categoryForFolder(folder), expected);
  });
}

test('categoryForFolder accepts an NFD-normalised "Hörbücher"', () => {
  const nfd = 'Hörbücher'.normalize('NFD');
  assert.equal(categoryForFolder(nfd), 'audiobooks');
});

test('categoryForFolder returns null for unknown folders', () => {
  assert.equal(categoryForFolder('Downloads'), null);
  assert.equal(categoryForFolder(''), null);
  assert.equal(categoryForFolder('Filme2'), null);
});

test('kindsFor returns the admitted kinds per category', () => {
  assert.deepEqual(kindsFor('movies'), ['video']);
  assert.deepEqual(kindsFor('series'), ['video']);
  assert.deepEqual(kindsFor('music'), ['audio']);
  assert.deepEqual(kindsFor('audiobooks'), ['audio']);
  assert.deepEqual(kindsFor('images'), ['image']);
});

test('kindsFor returns frozen arrays', () => {
  assert.ok(Object.isFrozen(kindsFor('movies')));
  assert.ok(Object.isFrozen(CATEGORIES));
});
