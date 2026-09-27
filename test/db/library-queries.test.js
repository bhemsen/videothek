import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/db/migrate.js';
import { upsertItem, upsertSeries } from '../../src/db/library-repo.js';
import {
  getItemById,
  getSeriesWithEpisodes,
  listCategoryItems,
  listSeries,
} from '../../src/db/library-queries.js';

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with 001+002 applied */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/**
 * @param {Partial<import('../../src/db/library-repo.js').LibraryItemInput>} overrides
 * @returns {import('../../src/db/library-repo.js').LibraryItemInput}
 */
function makeMovie(overrides = {}) {
  return {
    rel_path: 'Filme/Arrival (2016).mp4',
    dir: 'Filme',
    category: 'movies',
    kind: 'video',
    ext: 'mp4',
    title: 'Arrival',
    sort_title: 'arrival',
    year: 2016,
    playable: true,
    size: 1000,
    mtime_ms: 1_700_000_000_000,
    scan_version: 1,
    ...overrides,
  };
}

/**
 * @param {{ rel_path: string, seriesId: number, seriesTitle: string, season: number | null,
 *   episode: number | null, episodeEnd?: number | null, playable?: boolean, title?: string }} opts
 * @returns {import('../../src/db/library-repo.js').LibraryItemInput}
 */
function makeEpisode({ rel_path, seriesId, seriesTitle, season, episode, episodeEnd = null, playable = true, title }) {
  const episodeTitle = title ?? rel_path.slice(rel_path.lastIndexOf('/') + 1);
  return {
    rel_path,
    dir: rel_path.slice(0, rel_path.lastIndexOf('/')),
    category: 'series',
    kind: 'video',
    ext: 'mp4',
    title: episodeTitle,
    sort_title: episodeTitle.toLowerCase(),
    series_id: seriesId,
    series_title: seriesTitle,
    season,
    episode,
    episode_end: episodeEnd,
    playable,
    size: 100,
    mtime_ms: 1,
    scan_version: 1,
  };
}

test('listCategoryItems sort=title orders by sort_title, year IS NULL last, then id', () => {
  const db = makeDb();
  try {
    upsertItem(db, makeMovie({ rel_path: 'Filme/B.mp4', sort_title: 'b title' }), 1000);
    upsertItem(db, makeMovie({ rel_path: 'Filme/A-2020.mp4', sort_title: 'a title', year: 2020 }), 1000);
    upsertItem(db, makeMovie({ rel_path: 'Filme/A-noyear.mp4', sort_title: 'a title', year: null }), 1000);

    const rows = listCategoryItems(db, 'movies', 'title');
    assert.deepEqual(rows.map((r) => r.rel_path), ['Filme/A-2020.mp4', 'Filme/A-noyear.mp4', 'Filme/B.mp4']);
  } finally {
    db.close();
  }
});

test('listCategoryItems sort=added orders by added_at desc, mtime_ms desc, then id', () => {
  const db = makeDb();
  try {
    upsertItem(db, makeMovie({ rel_path: 'Filme/Old.mp4' }), 1000);
    upsertItem(db, makeMovie({ rel_path: 'Filme/TieLow.mp4', mtime_ms: 1000 }), 2000);
    upsertItem(db, makeMovie({ rel_path: 'Filme/TieHigh.mp4', mtime_ms: 2000 }), 2000);

    const rows = listCategoryItems(db, 'movies', 'added');
    assert.deepEqual(rows.map((r) => r.rel_path), ['Filme/TieHigh.mp4', 'Filme/TieLow.mp4', 'Filme/Old.mp4']);
  } finally {
    db.close();
  }
});

test('listSeries: seasonCount counts seasons >= 1 only, episodeCount all, playableCount playable, addedAt = max episode added_at', () => {
  const db = makeDb();
  try {
    const seriesId = upsertSeries(db, { series_key: 'Dark', title: 'Dark', sort_title: 'dark', year: 2017 }, 100);
    upsertItem(db, makeEpisode({ rel_path: 'Serien/Dark/S1E1.mp4', seriesId, seriesTitle: 'Dark', season: 1, episode: 1 }), 1000);
    upsertItem(
      db,
      makeEpisode({ rel_path: 'Serien/Dark/S1E2.mp4', seriesId, seriesTitle: 'Dark', season: 1, episode: 2, playable: false }),
      1500
    );
    upsertItem(db, makeEpisode({ rel_path: 'Serien/Dark/S0E1.mp4', seriesId, seriesTitle: 'Dark', season: 0, episode: 1 }), 2000);
    upsertItem(
      db,
      makeEpisode({ rel_path: 'Serien/Dark/Extras/I.mp4', seriesId, seriesTitle: 'Dark', season: null, episode: null }),
      3000
    );

    const [series] = listSeries(db, 'title');
    assert.equal(series.id, seriesId);
    assert.equal(series.seasonCount, 1, 'season 0 and null are not counted');
    assert.equal(series.episodeCount, 4);
    assert.equal(series.playableCount, 3);
    assert.equal(series.addedAt, 3000, 'max added_at across episodes, not library_series.added_at');
  } finally {
    db.close();
  }
});

test('listSeries: appears only while it has items (orphaned series excluded)', () => {
  const db = makeDb();
  try {
    upsertSeries(db, { series_key: 'Empty', title: 'Empty', sort_title: 'empty', year: null }, 100);
    assert.deepEqual(listSeries(db, 'title'), []);
  } finally {
    db.close();
  }
});

test('listSeries sort=title/added ordering', () => {
  const db = makeDb();
  try {
    const babylonId = upsertSeries(db, { series_key: 'Babylon Berlin', title: 'Babylon Berlin', sort_title: 'babylon berlin', year: null }, 1);
    const darkId = upsertSeries(db, { series_key: 'Dark', title: 'Dark', sort_title: 'dark', year: 2017 }, 2);
    const strombergId = upsertSeries(db, { series_key: 'Stromberg', title: 'Stromberg', sort_title: 'stromberg', year: null }, 3);
    upsertItem(db, makeEpisode({ rel_path: 'Serien/Babylon.Berlin.S01E01.mp4', seriesId: babylonId, seriesTitle: 'Babylon Berlin', season: 1, episode: 1 }), 100);
    upsertItem(db, makeEpisode({ rel_path: 'Serien/Dark/S1E1.mp4', seriesId: darkId, seriesTitle: 'Dark', season: 1, episode: 1 }), 500);
    upsertItem(db, makeEpisode({ rel_path: 'Serien/Stromberg/S1E1.mp4', seriesId: strombergId, seriesTitle: 'Stromberg', season: 1, episode: 1 }), 300);

    assert.deepEqual(listSeries(db, 'title').map((s) => s.id), [babylonId, darkId, strombergId]);
    assert.deepEqual(listSeries(db, 'added').map((s) => s.id), [darkId, strombergId, babylonId]);
  } finally {
    db.close();
  }
});

test('getSeriesWithEpisodes orders seasons 1..n, then 0 (Specials), then null (Weitere Folgen)', () => {
  const db = makeDb();
  try {
    const seriesId = upsertSeries(db, { series_key: 'Dark', title: 'Dark', sort_title: 'dark', year: 2017 }, 100);
    upsertItem(db, makeEpisode({ rel_path: 'Serien/Dark/S2E1.mp4', seriesId, seriesTitle: 'Dark', season: 2, episode: 1 }), 400);
    upsertItem(db, makeEpisode({ rel_path: 'Serien/Dark/Extras/I.mp4', seriesId, seriesTitle: 'Dark', season: null, episode: null }), 500);
    upsertItem(db, makeEpisode({ rel_path: 'Serien/Dark/S1E1.mp4', seriesId, seriesTitle: 'Dark', season: 1, episode: 1 }), 100);
    upsertItem(db, makeEpisode({ rel_path: 'Serien/Dark/S1E2.mp4', seriesId, seriesTitle: 'Dark', season: 1, episode: 2 }), 200);
    upsertItem(db, makeEpisode({ rel_path: 'Serien/Dark/S0E1.mp4', seriesId, seriesTitle: 'Dark', season: 0, episode: 1 }), 300);

    const detail = getSeriesWithEpisodes(db, seriesId);
    assert.ok(detail);
    assert.deepEqual(detail.seasons.map((s) => s.season), [1, 2, 0, null]);
    assert.deepEqual(detail.seasons[0].episodes.map((e) => e.rel_path), ['Serien/Dark/S1E1.mp4', 'Serien/Dark/S1E2.mp4']);
    assert.equal(detail.seasonCount, 2);
    assert.equal(detail.episodeCount, 5);
    assert.equal(detail.addedAt, 500);
  } finally {
    db.close();
  }
});

test('getSeriesWithEpisodes: within a season, episode NULL last, then episode_end, then sort_title, then id', () => {
  const db = makeDb();
  try {
    const seriesId = upsertSeries(db, { series_key: 'Dark', title: 'Dark', sort_title: 'dark', year: 2017 }, 100);
    const unnumbered = upsertItem(db, makeEpisode({ rel_path: 'Serien/Dark/Unnumbered.mp4', seriesId, seriesTitle: 'Dark', season: 1, episode: null }), 100);
    const multi = upsertItem(
      db,
      makeEpisode({ rel_path: 'Serien/Dark/S1E01-E02.mp4', seriesId, seriesTitle: 'Dark', season: 1, episode: 1, episodeEnd: 2 }),
      200
    );
    const single = upsertItem(db, makeEpisode({ rel_path: 'Serien/Dark/S1E01.mp4', seriesId, seriesTitle: 'Dark', season: 1, episode: 1 }), 300);

    const detail = getSeriesWithEpisodes(db, seriesId);
    assert.ok(detail);
    assert.deepEqual(detail.seasons[0].episodes.map((e) => e.id), [single, multi, unnumbered]);
  } finally {
    db.close();
  }
});

test('getSeriesWithEpisodes returns undefined for an unknown id or a series with no items', () => {
  const db = makeDb();
  try {
    assert.equal(getSeriesWithEpisodes(db, 999), undefined);
    const emptyId = upsertSeries(db, { series_key: 'Empty', title: 'Empty', sort_title: 'empty', year: null }, 100);
    assert.equal(getSeriesWithEpisodes(db, emptyId), undefined);
  } finally {
    db.close();
  }
});

test('getItemById returns the full row incl. rel_path, or undefined for an unknown id', () => {
  const db = makeDb();
  try {
    const id = upsertItem(db, makeMovie(), 1000);
    const row = getItemById(db, id);
    assert.ok(row);
    assert.equal(row.rel_path, 'Filme/Arrival (2016).mp4');
    assert.equal(getItemById(db, id + 999), undefined);
  } finally {
    db.close();
  }
});
