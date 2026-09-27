import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  episodeTitleFor,
  overlineFor,
  headingFor,
  nextLabel,
  subtitleLabels,
  errorStateFor,
  backTarget,
} from '../../public/js/lib/player-format.js';

// --- overlineFor / headingFor -----------------------------------------

test('overlineFor and headingFor for a movie', () => {
  const item = { category: 'movies', title: 'Das Boot' };
  assert.equal(overlineFor(item), 'Film');
  assert.equal(headingFor(item), 'Das Boot');
});

test('overlineFor and headingFor for a numbered episode with a real title', () => {
  const item = {
    category: 'series',
    seriesTitle: 'Sturmflut',
    title: 'Geheimnisse',
    season: 1,
    episode: 2,
    episodeEnd: null,
  };
  assert.equal(overlineFor(item), 'Sturmflut');
  assert.equal(headingFor(item), 'S01E02 · Geheimnisse');
});

test('headingFor falls back to "Folge N" when the title equals the episode code', () => {
  const item = {
    category: 'series',
    seriesTitle: 'Sturmflut',
    title: 'S01E03',
    season: 1,
    episode: 3,
    episodeEnd: null,
  };
  assert.equal(headingFor(item), 'S01E03 · Folge 3');
});

test('headingFor falls back to "Folgen a–b" for a double-episode code title', () => {
  const item = {
    category: 'series',
    seriesTitle: 'Sturmflut',
    title: 'S01E01-E02',
    season: 1,
    episode: 1,
    episodeEnd: 2,
  };
  assert.equal(headingFor(item), 'S01E01-E02 · Folgen 1–2');
});

test('headingFor keeps a real title for a double episode', () => {
  const item = {
    category: 'series',
    seriesTitle: 'Sturmflut',
    title: 'Der Sturm',
    season: 1,
    episode: 1,
    episodeEnd: 2,
  };
  assert.equal(headingFor(item), 'S01E01-E02 · Der Sturm');
});

test('headingFor omits the season prefix and falls back when the season is unknown', () => {
  const item = {
    category: 'series',
    seriesTitle: 'Sturmflut',
    title: 'E06',
    season: null,
    episode: 6,
    episodeEnd: null,
  };
  assert.equal(headingFor(item), 'E06 · Folge 6');
});

test('headingFor returns just the title when the episode number is unknown', () => {
  const item = {
    category: 'series',
    seriesTitle: 'Sturmflut',
    title: 'Interview',
    season: null,
    episode: null,
    episodeEnd: null,
  };
  assert.equal(headingFor(item), 'Interview');
});

test('episodeTitleFor matches the code case-insensitively', () => {
  assert.equal(
    episodeTitleFor({ title: 's01e03', season: 1, episode: 3, episodeEnd: null }),
    'Folge 3',
  );
});

// --- nextLabel -----------------------------------------------------------

test('nextLabel builds the "Nächste Folge: …" button label', () => {
  const next = { id: 12, title: 'Sturmflut', season: 1, episode: 3, episodeEnd: null };
  assert.equal(nextLabel(next), 'Nächste Folge: S01E03 · Sturmflut');
});

test('nextLabel returns null when there is no next episode', () => {
  assert.equal(nextLabel(null), null);
});

// --- subtitleLabels --------------------------------------------------------

test('subtitleLabels resolves a known language code to its German name', () => {
  assert.deepEqual(subtitleLabels([{ index: 0, lang: 'de', label: null }]), ['Deutsch']);
});

test('subtitleLabels falls back to the free-form label when there is no lang', () => {
  assert.deepEqual(
    subtitleLabels([{ index: 0, lang: null, label: 'Kommentar' }]),
    ['Kommentar'],
  );
});

test('subtitleLabels falls back to "Untertitel" when neither lang nor label is set', () => {
  assert.deepEqual(subtitleLabels([{ index: 0, lang: null, label: null }]), ['Untertitel']);
});

test('subtitleLabels upper-cases an unrecognized language code instead of returning it unchanged', () => {
  assert.deepEqual(subtitleLabels([{ index: 0, lang: 'xx', label: null }]), ['XX']);
});

test('subtitleLabels upper-cases a language code that throws in Intl.DisplayNames', () => {
  assert.deepEqual(
    subtitleLabels([{ index: 0, lang: 'toolongcodevalue', label: null }]),
    ['TOOLONGCODEVALUE'],
  );
});

test('subtitleLabels numbers repeated labels in order of appearance', () => {
  const result = subtitleLabels([
    { index: 0, lang: 'de', label: null },
    { index: 1, lang: null, label: null },
    { index: 2, lang: 'de', label: null },
    { index: 3, lang: null, label: null },
  ]);
  assert.deepEqual(result, ['Deutsch', 'Untertitel', 'Deutsch (2)', 'Untertitel (2)']);
});

// --- errorStateFor -----------------------------------------------------

test('errorStateFor maps a 404 HEAD probe to file-missing', () => {
  assert.equal(errorStateFor({ headStatus: 404, mediaErrorCode: 4 }), 'file-missing');
});

test('errorStateFor maps a 2xx probe with MediaError code 2 to connection-lost', () => {
  assert.equal(errorStateFor({ headStatus: 200, mediaErrorCode: 2 }), 'connection-lost');
});

test('errorStateFor maps a 2xx probe with MediaError code 3 or 4 to codec', () => {
  assert.equal(errorStateFor({ headStatus: 200, mediaErrorCode: 3 }), 'codec');
  assert.equal(errorStateFor({ headStatus: 200, mediaErrorCode: 4 }), 'codec');
});

test('errorStateFor maps a network failure (no HTTP status) to connection-lost', () => {
  assert.equal(errorStateFor({ headStatus: null, mediaErrorCode: 4 }), 'connection-lost');
  assert.equal(errorStateFor({ headStatus: undefined, mediaErrorCode: 3 }), 'connection-lost');
});

test('errorStateFor maps a 500 (or any other status) to connection-lost', () => {
  assert.equal(errorStateFor({ headStatus: 500, mediaErrorCode: 3 }), 'connection-lost');
});

// --- backTarget ----------------------------------------------------------

test('backTarget goes back for a same-origin referrer with a real previous page', () => {
  assert.equal(
    backTarget({
      referrer: 'https://videothek.example/movies',
      origin: 'https://videothek.example',
      historyLength: 2,
    }),
    'back',
  );
});

test('backTarget goes home when there is no real previous page (historyLength 1)', () => {
  assert.equal(
    backTarget({
      referrer: 'https://videothek.example/movies',
      origin: 'https://videothek.example',
      historyLength: 1,
    }),
    'home',
  );
});

test('backTarget goes home for a cross-origin referrer', () => {
  assert.equal(
    backTarget({
      referrer: 'https://evil.example/movies',
      origin: 'https://videothek.example',
      historyLength: 2,
    }),
    'home',
  );
});

test('backTarget goes home for an empty or unparsable referrer', () => {
  assert.equal(
    backTarget({ referrer: '', origin: 'https://videothek.example', historyLength: 2 }),
    'home',
  );
  assert.equal(
    backTarget({ referrer: 'not a url', origin: 'https://videothek.example', historyLength: 2 }),
    'home',
  );
});

test('backTarget goes home for a same-origin /login referrer (avoids a login loop)', () => {
  assert.equal(
    backTarget({
      referrer: 'https://videothek.example/login?next=%2Fplayer%3Fid%3D1',
      origin: 'https://videothek.example',
      historyLength: 2,
    }),
    'home',
  );
});
