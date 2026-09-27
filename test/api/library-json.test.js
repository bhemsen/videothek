import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toItemJson } from '../../src/api/library-json.js';

/**
 * Builds a raw `library_items` row as `node:sqlite` actually returns one
 * (`playable` a real `0`/`1`, not a JS boolean — see `library-repo.js`'s own
 * `LibraryItemRow` typedef note), cast at the boundary like the driver's own
 * results are elsewhere in this codebase.
 * @param {Record<string, unknown>} overrides
 */
function makeRow(overrides = {}) {
  const row = {
    id: 42,
    rel_path: 'Filme/Arrival (2016).mp4',
    dir: 'Filme',
    category: 'movies',
    kind: 'video',
    ext: 'mp4',
    title: 'Arrival',
    sort_title: 'arrival',
    year: 2016,
    series_id: null,
    series_title: null,
    season: null,
    episode: null,
    episode_end: null,
    video_codec: null,
    audio_codec: null,
    playable: 1,
    size: 1_000_000,
    mtime_ms: 1_700_000_000_000,
    scan_version: 1,
    added_at: Date.parse('2026-09-26T10:00:00.000Z'),
    scanned_at: Date.parse('2026-09-26T10:00:00.000Z'),
    ...overrides,
  };
  return /** @type {import('../../src/db/library-repo.js').LibraryItemRow} */ (/** @type {unknown} */ (row));
}

test('toItemJson matches the spec shape exactly, with an ISO addedAt', () => {
  const row = makeRow({
    id: 42,
    category: 'series',
    title: 'Geheimnisse',
    year: null,
    size: 1_503_238_553,
    playable: 1,
    video_codec: 'avc1',
    audio_codec: 'mp4a',
    series_id: 7,
    series_title: 'Dark',
    season: 1,
    episode: 1,
    rel_path: 'Serien/Dark/Staffel 1/Dark S01E01 - Geheimnisse.mp4',
  });

  assert.deepEqual(toItemJson(row), {
    id: 42,
    category: 'series',
    kind: 'video',
    title: 'Geheimnisse',
    year: null,
    ext: 'mp4',
    size: 1_503_238_553,
    playable: true,
    videoCodec: 'avc1',
    audioCodec: 'mp4a',
    addedAt: '2026-09-26T10:00:00.000Z',
    seriesId: 7,
    seriesTitle: 'Dark',
    season: 1,
    episode: 1,
    episodeEnd: null,
    fileName: 'Dark S01E01 - Geheimnisse.mp4',
  });
});

test('toItemJson never carries relPath/rel_path or dir', () => {
  const json = /** @type {Record<string, unknown>} */ (toItemJson(makeRow()));
  assert.equal('relPath' in json, false);
  assert.equal('rel_path' in json, false);
  assert.equal('dir' in json, false);
});

test('toItemJson: playable 0/1 becomes a real boolean; nullable fields are null, never undefined', () => {
  const unplayable = /** @type {Record<string, unknown>} */ (toItemJson(makeRow({ playable: 0 })));
  assert.equal(unplayable.playable, false);

  const playable = /** @type {Record<string, unknown>} */ (toItemJson(makeRow({ playable: 1 })));
  assert.equal(playable.playable, true);

  const bare = /** @type {Record<string, unknown>} */ (toItemJson(makeRow({ year: null })));
  for (const key of ['year', 'videoCodec', 'audioCodec', 'seriesId', 'seriesTitle', 'season', 'episode', 'episodeEnd']) {
    assert.ok(key in bare, `expected key ${key} to be present`);
    assert.equal(bare[key], null);
  }
});

test('toItemJson: fileName is the last rel_path segment', () => {
  const json = toItemJson(makeRow({ rel_path: 'Serien/Dark/Staffel 2/Dark S02E01 - Anfänge und Enden.mp4' }));
  assert.equal(json.fileName, 'Dark S02E01 - Anfänge und Enden.mp4');
});
