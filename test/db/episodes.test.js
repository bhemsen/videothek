import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { upsertItem, upsertSeries } from '../../src/db/library-repo.js';
import { getNextEpisode } from '../../src/db/episodes.js';

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with 001+002 applied */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @returns {number}
 */
function makeSeries(db, key) {
  return upsertSeries(db, { series_key: key, title: key, sort_title: key.toLowerCase() }, 1);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Partial<import('../../src/db/library-repo.js').LibraryItemInput>} overrides
 * @returns {import('../../src/db/library-repo.js').LibraryItemRow}
 */
function makeEpisode(db, overrides) {
  const item = {
    rel_path: `Serien/${overrides.series_title}/${Math.random()}.mp4`,
    dir: `Serien/${overrides.series_title}`,
    category: /** @type {const} */ ('series'),
    kind: /** @type {const} */ ('video'),
    ext: 'mp4',
    title: 'Episode',
    sort_title: 'episode',
    playable: true,
    size: 1000,
    mtime_ms: 1_700_000_000_000,
    scan_version: 1,
    ...overrides,
  };
  const id = upsertItem(db, item, 1);
  return /** @type {import('../../src/db/library-repo.js').LibraryItemRow} */ (
    /** @type {unknown} */ (db.prepare('SELECT * FROM library_items WHERE id = ?').get(id))
  );
}

test('getNextEpisode: last of S01 chains to the first of S02', () => {
  const db = makeDb();
  try {
    const seriesId = makeSeries(db, 'Dark');
    makeEpisode(db, { series_id: seriesId, series_title: 'Dark', season: 1, episode: 1, rel_path: 'Serien/Dark/s01e01.mp4' });
    const s01e02 = makeEpisode(db, { series_id: seriesId, series_title: 'Dark', season: 1, episode: 2, rel_path: 'Serien/Dark/s01e02.mp4' });
    const s02e01 = makeEpisode(db, { series_id: seriesId, series_title: 'Dark', season: 2, episode: 1, rel_path: 'Serien/Dark/s02e01.mp4' });

    const next = getNextEpisode(db, s01e02);

    assert.ok(next);
    assert.equal(next.id, s02e01.id);
  } finally {
    db.close();
  }
});

test('getNextEpisode: last regular episode is null even when specials exist', () => {
  const db = makeDb();
  try {
    const seriesId = makeSeries(db, 'Dark');
    const s02e01 = makeEpisode(db, { series_id: seriesId, series_title: 'Dark', season: 2, episode: 1, rel_path: 'Serien/Dark/s02e01.mp4' });
    makeEpisode(db, { series_id: seriesId, series_title: 'Dark', season: 0, episode: 1, rel_path: 'Serien/Dark/s00e01.mp4' });

    assert.equal(getNextEpisode(db, s02e01), null);
  } finally {
    db.close();
  }
});

test('getNextEpisode: S00E01 chains to S00E02, own chain from regular seasons', () => {
  const db = makeDb();
  try {
    const seriesId = makeSeries(db, 'Dark');
    const s00e01 = makeEpisode(db, { series_id: seriesId, series_title: 'Dark', season: 0, episode: 1, rel_path: 'Serien/Dark/s00e01.mp4' });
    const s00e02 = makeEpisode(db, { series_id: seriesId, series_title: 'Dark', season: 0, episode: 2, rel_path: 'Serien/Dark/s00e02.mp4' });
    makeEpisode(db, { series_id: seriesId, series_title: 'Dark', season: 1, episode: 1, rel_path: 'Serien/Dark/s01e01.mp4' });

    const next = getNextEpisode(db, s00e01);

    assert.ok(next);
    assert.equal(next.id, s00e02.id);
  } finally {
    db.close();
  }
});

test('getNextEpisode: last special is null', () => {
  const db = makeDb();
  try {
    const seriesId = makeSeries(db, 'Dark');
    const s00e02 = makeEpisode(db, { series_id: seriesId, series_title: 'Dark', season: 0, episode: 2, rel_path: 'Serien/Dark/s00e02.mp4' });

    assert.equal(getNextEpisode(db, s00e02), null);
  } finally {
    db.close();
  }
});

test('getNextEpisode: double episode E01-E02 chains to E03', () => {
  const db = makeDb();
  try {
    const seriesId = makeSeries(db, 'DoubleEp');
    const e01e02 = makeEpisode(db, { series_id: seriesId, series_title: 'DoubleEp', season: 1, episode: 1, episode_end: 2, rel_path: 'Serien/DoubleEp/s01e01-e02.mp4' });
    const e03 = makeEpisode(db, { series_id: seriesId, series_title: 'DoubleEp', season: 1, episode: 3, rel_path: 'Serien/DoubleEp/s01e03.mp4' });

    const next = getNextEpisode(db, e01e02);

    assert.ok(next);
    assert.equal(next.id, e03.id);
  } finally {
    db.close();
  }
});

test('getNextEpisode: double episode E01-E02 prefers a separate E02 file over E03', () => {
  const db = makeDb();
  try {
    const seriesId = makeSeries(db, 'DoubleEpSplit');
    const e01e02 = makeEpisode(db, { series_id: seriesId, series_title: 'DoubleEpSplit', season: 1, episode: 1, episode_end: 2, rel_path: 'Serien/DoubleEpSplit/s01e01-e02.mp4' });
    const e02solo = makeEpisode(db, { series_id: seriesId, series_title: 'DoubleEpSplit', season: 1, episode: 2, rel_path: 'Serien/DoubleEpSplit/s01e02.mp4' });
    makeEpisode(db, { series_id: seriesId, series_title: 'DoubleEpSplit', season: 1, episode: 3, rel_path: 'Serien/DoubleEpSplit/s01e03.mp4' });

    const next = getNextEpisode(db, e01e02);

    assert.ok(next);
    assert.equal(next.id, e02solo.id, 'episode_end NULL sorts before a non-null episode_end (P2 order)');
  } finally {
    db.close();
  }
});

test('getNextEpisode: two files of one episode are ordered by sort_title then id', () => {
  const db = makeDb();
  try {
    const seriesId = makeSeries(db, 'SameEp');
    const e01 = makeEpisode(db, { series_id: seriesId, series_title: 'SameEp', season: 1, episode: 1, rel_path: 'Serien/SameEp/s01e01.mp4' });
    makeEpisode(db, { series_id: seriesId, series_title: 'SameEp', season: 1, episode: 2, sort_title: 'b', rel_path: 'Serien/SameEp/s01e02-b.mp4' });
    const e02a = makeEpisode(db, { series_id: seriesId, series_title: 'SameEp', season: 1, episode: 2, sort_title: 'a', rel_path: 'Serien/SameEp/s01e02-a.mp4' });

    const next = getNextEpisode(db, e01);

    assert.ok(next);
    assert.equal(next.id, e02a.id, 'lower sort_title wins');
  } finally {
    db.close();
  }
});

test('getNextEpisode: with equal sort_title, the lower id wins', () => {
  const db = makeDb();
  try {
    const seriesId = makeSeries(db, 'SameSortTitle');
    const e01 = makeEpisode(db, { series_id: seriesId, series_title: 'SameSortTitle', season: 1, episode: 1, rel_path: 'Serien/SameSortTitle/s01e01.mp4' });
    const e02First = makeEpisode(db, { series_id: seriesId, series_title: 'SameSortTitle', season: 1, episode: 2, sort_title: 'same', rel_path: 'Serien/SameSortTitle/s01e02-first.mp4' });
    makeEpisode(db, { series_id: seriesId, series_title: 'SameSortTitle', season: 1, episode: 2, sort_title: 'same', rel_path: 'Serien/SameSortTitle/s01e02-second.mp4' });

    const next = getNextEpisode(db, e01);

    assert.ok(next);
    assert.equal(next.id, e02First.id, 'the row inserted (and thus id-ed) first wins the tie');
  } finally {
    db.close();
  }
});

test('getNextEpisode: an unnumbered row is never returned and has none itself', () => {
  const db = makeDb();
  try {
    const seriesId = makeSeries(db, 'Unnumbered');
    const e01 = makeEpisode(db, { series_id: seriesId, series_title: 'Unnumbered', season: 1, episode: 1, rel_path: 'Serien/Unnumbered/s01e01.mp4' });
    const loose = makeEpisode(db, { series_id: seriesId, series_title: 'Unnumbered', season: 1, episode: null, sort_title: 'zzz-loose', rel_path: 'Serien/Unnumbered/loose-file.mp4' });

    assert.equal(getNextEpisode(db, e01), null, 'the unnumbered row must not be picked as next');
    assert.equal(getNextEpisode(db, loose), null, 'an unnumbered row itself has no next');
  } finally {
    db.close();
  }
});

test('getNextEpisode: NULL season yields null', () => {
  const db = makeDb();
  try {
    const seriesId = makeSeries(db, 'NoSeason');
    const row = makeEpisode(db, { series_id: seriesId, series_title: 'NoSeason', season: null, episode: 1, rel_path: 'Serien/NoSeason/loose.mp4' });

    assert.equal(getNextEpisode(db, row), null);
  } finally {
    db.close();
  }
});

test('getNextEpisode: a movie (no series_id) yields null', () => {
  const db = makeDb();
  try {
    const movie = { rel_path: 'Filme/Arrival (2016).mp4', dir: 'Filme', category: /** @type {const} */ ('movies'), kind: /** @type {const} */ ('video'), ext: 'mp4', title: 'Arrival', sort_title: 'arrival', playable: true, size: 1000, mtime_ms: 1, scan_version: 1 };
    const id = upsertItem(db, movie, 1);
    const row = /** @type {import('../../src/db/library-repo.js').LibraryItemRow} */ (
      /** @type {unknown} */ (db.prepare('SELECT * FROM library_items WHERE id = ?').get(id))
    );

    assert.equal(getNextEpisode(db, row), null);
  } finally {
    db.close();
  }
});

test('getNextEpisode: a non-playable successor is returned, not skipped', () => {
  const db = makeDb();
  try {
    const seriesId = makeSeries(db, 'NonPlayable');
    const e01 = makeEpisode(db, { series_id: seriesId, series_title: 'NonPlayable', season: 1, episode: 1, rel_path: 'Serien/NonPlayable/s01e01.mp4' });
    const e02 = makeEpisode(db, { series_id: seriesId, series_title: 'NonPlayable', season: 1, episode: 2, playable: false, rel_path: 'Serien/NonPlayable/s01e02.mkv' });

    const next = getNextEpisode(db, e01);

    assert.ok(next);
    assert.equal(next.id, e02.id);
    assert.equal(next.playable, 0);
  } finally {
    db.close();
  }
});
