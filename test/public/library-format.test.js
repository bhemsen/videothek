import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initials,
  pluralize,
  formatFileSize,
  episodeNumber,
  episodeCode,
  episodeLabel,
} from '../../public/js/lib/library-format.js';

test('initials takes the first letter/digit of the first two words, upper-cased', () => {
  assert.equal(initials('Blade Runner 2049'), 'BR');
  assert.equal(initials('Das Boot'), 'DB');
  assert.equal(initials('300'), '3');
});

test('initials returns a single character for a one-word title', () => {
  assert.equal(initials('Arrival'), 'A');
  assert.equal(initials('Soul'), 'S');
});

test('initials falls back to # when neither word has a letter or digit', () => {
  assert.equal(initials('...'), '#');
  assert.equal(initials(''), '#');
  assert.equal(initials('  '), '#');
});

test('initials ignores extra whitespace and only looks at the first two words', () => {
  assert.equal(initials('  Der   Herr  der Ringe'), 'DH');
});

test('pluralize uses the singular only for exactly 1', () => {
  assert.equal(pluralize(1, 'Titel', 'Titel'), '1 Titel');
  assert.equal(pluralize(1, 'Serie', 'Serien'), '1 Serie');
  assert.equal(pluralize(1, 'Staffel', 'Staffeln'), '1 Staffel');
  assert.equal(pluralize(1, 'Folge', 'Folgen'), '1 Folge');
});

test('pluralize uses the plural for 0 and for more than 1', () => {
  assert.equal(pluralize(0, 'Serie', 'Serien'), '0 Serien');
  assert.equal(pluralize(12, 'Titel', 'Titel'), '12 Titel');
  assert.equal(pluralize(8, 'Serie', 'Serien'), '8 Serien');
  assert.equal(pluralize(3, 'Staffel', 'Staffeln'), '3 Staffeln');
  assert.equal(pluralize(26, 'Folge', 'Folgen'), '26 Folgen');
});

test('formatFileSize keeps bytes below 1024 as an integer', () => {
  assert.equal(formatFileSize(0), '0 B');
  assert.equal(formatFileSize(512), '512 B');
  assert.equal(formatFileSize(1023), '1023 B');
});

test('formatFileSize uses 1024-based units with one de-DE decimal from 1024 B up', () => {
  assert.equal(formatFileSize(1024), '1,0 KB');
  assert.equal(formatFileSize(1536), '1,5 KB');
  assert.equal(formatFileSize(1024 * 1024), '1,0 MB');
  assert.equal(formatFileSize(1503238553), '1,4 GB');
});

test('formatFileSize never exceeds GB, the largest unit', () => {
  assert.equal(formatFileSize(1024 ** 4), '1.024,0 GB');
});

test('episodeNumber pads a single episode to at least 2 digits', () => {
  assert.equal(episodeNumber({ episode: 1, episodeEnd: null }), '01');
  assert.equal(episodeNumber({ episode: 12, episodeEnd: null }), '12');
});

test('episodeNumber formats a multi-episode range with an en dash', () => {
  assert.equal(episodeNumber({ episode: 1, episodeEnd: 2 }), '01–02');
});

test('episodeNumber returns an en dash alone when the episode is unknown', () => {
  assert.equal(episodeNumber({ episode: null, episodeEnd: null }), '–');
});

test('episodeCode builds S..E.. forms with a known season', () => {
  assert.equal(episodeCode({ season: 1, episode: 6, episodeEnd: null }), 'S01E06');
  assert.equal(episodeCode({ season: 1, episode: 1, episodeEnd: 2 }), 'S01E01-E02');
  assert.equal(episodeCode({ season: 0, episode: 1, episodeEnd: null }), 'S00E01');
});

test('episodeCode drops the season prefix when the season is unknown', () => {
  assert.equal(episodeCode({ season: null, episode: 6, episodeEnd: null }), 'E06');
  assert.equal(episodeCode({ season: null, episode: 6, episodeEnd: 7 }), 'E06-E07');
});

test('episodeCode returns null when the episode is unknown', () => {
  assert.equal(episodeCode({ season: 1, episode: null, episodeEnd: null }), null);
});

test('episodeLabel keeps a real title unchanged', () => {
  assert.equal(
    episodeLabel({ title: 'Geheimnisse', season: 1, episode: 1, episodeEnd: null }),
    'Geheimnisse',
  );
});

test('episodeLabel falls back to "Folge N" when the title equals the episode code', () => {
  assert.equal(episodeLabel({ title: 'S01E03', season: 1, episode: 3, episodeEnd: null }), 'Folge 3');
});

test('episodeLabel falls back to "Folgen N–M" for a multi-episode code title', () => {
  assert.equal(
    episodeLabel({ title: 'S01E01-E02', season: 1, episode: 1, episodeEnd: 2 }),
    'Folgen 1–2',
  );
});

test('episodeLabel leaves an unnumbered episode’s title unchanged', () => {
  assert.equal(
    episodeLabel({ title: 'Interview', season: null, episode: null, episodeEnd: null }),
    'Interview',
  );
});
