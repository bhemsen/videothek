/**
 * `GET /api/progress` (the continue + all views) — query validation, the
 * exclusion rules, the `next_up` merge/order/limit and the effect of
 * `DELETE` on the continue view. Per-item routes and per-user isolation live
 * in `test/api/progress.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertItem, upsertSeries } from '../../src/db/library-repo.js';
import { upsertProgress } from '../../src/db/progress.js';
import { startTestApp } from '../helpers/app.js';

const PASSWORD = 'correct-horse-battery';

/**
 * @param {Partial<import('../../src/db/library-repo.js').LibraryItemInput>} overrides
 * @returns {import('../../src/db/library-repo.js').LibraryItemInput}
 */
function makeMovie(overrides = {}) {
  return {
    rel_path: 'Filme/Film.mp4',
    dir: 'Filme',
    category: 'movies',
    kind: 'video',
    ext: 'mp4',
    title: 'Film',
    sort_title: 'film',
    playable: true,
    size: 1000,
    mtime_ms: 1_700_000_000_000,
    scan_version: 1,
    ...overrides,
  };
}

/**
 * Seeds a two-episode series ("Show <key>"); `e1` is S01E01, `e2` S01E02.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @returns {{ e1: { id: number, relPath: string }, e2: { id: number, relPath: string } }}
 */
function seedShow(db, key) {
  const seriesId = upsertSeries(db, { series_key: key, title: `Show ${key}`, sort_title: `show ${key}` }, 1);
  const base = { series_id: seriesId, series_title: `Show ${key}`, category: /** @type {const} */ ('series') };
  const path1 = `Serien/${key}/Season 01/S01E01.mkv`;
  const path2 = `Serien/${key}/Season 01/S01E02.mkv`;
  const e1 = upsertItem(
    db,
    makeMovie({ ...base, rel_path: path1, dir: `Serien/${key}/Season 01`, season: 1, episode: 1, title: 'Folge 1', sort_title: 'folge 1' }),
    1,
  );
  const e2 = upsertItem(
    db,
    makeMovie({ ...base, rel_path: path2, dir: `Serien/${key}/Season 01`, season: 1, episode: 2, title: 'Folge 2', sort_title: 'folge 2' }),
    1,
  );
  return { e1: { id: e1, relPath: path1 }, e2: { id: e2, relPath: path2 } };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Partial<import('../../src/db/progress.js').UpsertProgressInput>} overrides
 */
function seedProgress(db, overrides) {
  upsertProgress(db, { userId: 1, relPath: '', positionSeconds: 40, durationSeconds: 3600, finished: false, updatedAt: 1000, ...overrides });
}

/**
 * @param {string} baseUrl
 * @param {string} pathname
 * @param {string} cookie
 * @returns {Promise<{ status: number, body: any }>}
 */
async function getJson(baseUrl, pathname, cookie) {
  const res = await fetch(`${baseUrl}${pathname}`, { headers: { Cookie: cookie } });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
}

/**
 * @param {string} baseUrl
 * @param {string} pathname
 * @param {string} cookie
 */
async function del(baseUrl, pathname, cookie) {
  const res = await fetch(`${baseUrl}${pathname}`, { method: 'DELETE', headers: { Cookie: cookie } });
  return { status: res.status };
}

test('a bad query answers 400 invalid_query', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', PASSWORD);
    const cookie = await app.login('alice', PASSWORD);
    const badQueries = [
      'category=images',
      'category=',
      'category=movies,nope',
      'view=bogus',
      'view=all&limit=1',
      'limit=0',
      'limit=51',
      'limit=abc',
    ];
    for (const query of badQueries) {
      const res = await getJson(app.baseUrl, `/api/progress?${query}`, cookie);
      assert.equal(res.status, 400, query);
      assert.deepEqual(res.body, { error: 'invalid_query' }, query);
    }
  } finally {
    await app.close();
  }
});

test('the continue view excludes finished, under-30s, non-playable and vanished items', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', PASSWORD);
    const cookie = await app.login('alice', PASSWORD);

    const started = upsertItem(app.db, makeMovie({ rel_path: 'Filme/Started.mp4', title: 'Started' }), 1);
    seedProgress(app.db, { relPath: 'Filme/Started.mp4', positionSeconds: 40, updatedAt: 1000 });

    upsertItem(app.db, makeMovie({ rel_path: 'Filme/Finished.mp4', title: 'Finished' }), 1);
    seedProgress(app.db, { relPath: 'Filme/Finished.mp4', finished: true, positionSeconds: 3500, updatedAt: 2000 });

    upsertItem(app.db, makeMovie({ rel_path: 'Filme/Under30.mp4', title: 'Under30' }), 1);
    seedProgress(app.db, { relPath: 'Filme/Under30.mp4', positionSeconds: 10, updatedAt: 3000 });

    upsertItem(app.db, makeMovie({ rel_path: 'Filme/Kaputt.avi', title: 'Kaputt', playable: false }), 1);
    seedProgress(app.db, { relPath: 'Filme/Kaputt.avi', positionSeconds: 40, updatedAt: 4000 });

    seedProgress(app.db, { relPath: 'Filme/Vanished.mp4', positionSeconds: 40, updatedAt: 5000 });

    const res = await getJson(app.baseUrl, '/api/progress?category=movies', cookie);
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.items.map((/** @type {any} */ item) => item.itemId),
      [started],
    );
  } finally {
    await app.close();
  }
});

test('next_up appears only when series is requested', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', PASSWORD);
    const cookie = await app.login('alice', PASSWORD);
    const { e1, e2 } = seedShow(app.db, 'A');
    seedProgress(app.db, { relPath: e1.relPath, finished: true, positionSeconds: 1400, updatedAt: 1000 });

    const withoutSeries = await getJson(app.baseUrl, '/api/progress?category=movies', cookie);
    assert.deepEqual(withoutSeries.body.items, []);

    const withSeries = await getJson(app.baseUrl, '/api/progress?category=series', cookie);
    assert.equal(withSeries.body.items.length, 1);
    const [entry] = withSeries.body.items;
    assert.equal(entry.itemId, e2.id);
    assert.equal(entry.state, 'next_up');
    assert.equal(entry.position, 0);
    assert.equal(entry.item.id, e2.id);
  } finally {
    await app.close();
  }
});

test('entries are ordered by updatedAt desc (itemId desc on ties), limit applied after the next_up merge', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', PASSWORD);
    const cookie = await app.login('alice', PASSWORD);

    const older = upsertItem(app.db, makeMovie({ rel_path: 'Filme/Older.mp4', title: 'Older' }), 1);
    seedProgress(app.db, { relPath: 'Filme/Older.mp4', positionSeconds: 40, updatedAt: 200 });
    const newest = upsertItem(app.db, makeMovie({ rel_path: 'Filme/Newest.mp4', title: 'Newest' }), 1);
    seedProgress(app.db, { relPath: 'Filme/Newest.mp4', positionSeconds: 40, updatedAt: 300 });

    const { e1, e2 } = seedShow(app.db, 'B');
    seedProgress(app.db, { relPath: e1.relPath, finished: true, positionSeconds: 1400, updatedAt: 250 });

    const res = await getJson(app.baseUrl, '/api/progress?category=movies,series&limit=2', cookie);
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.items.map((/** @type {any} */ item) => item.itemId),
      [newest, e2.id],
    );
    assert.ok(!res.body.items.some((/** @type {any} */ item) => item.itemId === older));
  } finally {
    await app.close();
  }
});

test('continue-view entries carry item; all-view entries do not, and include finished ones', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', PASSWORD);
    const cookie = await app.login('alice', PASSWORD);
    const started = upsertItem(app.db, makeMovie({ rel_path: 'Filme/Started.mp4', title: 'Started' }), 1);
    seedProgress(app.db, { relPath: 'Filme/Started.mp4', positionSeconds: 40, updatedAt: 1000 });
    const finished = upsertItem(app.db, makeMovie({ rel_path: 'Filme/Finished.mp4', title: 'Finished' }), 1);
    seedProgress(app.db, { relPath: 'Filme/Finished.mp4', finished: true, positionSeconds: 3500, updatedAt: 2000 });

    const continueView = await getJson(app.baseUrl, '/api/progress?category=movies', cookie);
    assert.equal(continueView.body.items.length, 1);
    assert.ok(continueView.body.items[0].item);
    assert.equal(continueView.body.items[0].item.id, started);

    const allView = await getJson(app.baseUrl, '/api/progress?category=movies&view=all', cookie);
    assert.deepEqual(
      allView.body.items.map((/** @type {any} */ item) => item.itemId).sort(),
      [started, finished].sort(),
    );
    assert.ok(allView.body.items.every((/** @type {any} */ item) => !('item' in item)));
  } finally {
    await app.close();
  }
});

test('DELETE of an in-progress movie removes it from the continue view', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', PASSWORD);
    const cookie = await app.login('alice', PASSWORD);
    const movieId = upsertItem(app.db, makeMovie({ rel_path: 'Filme/Started.mp4', title: 'Started' }), 1);
    seedProgress(app.db, { relPath: 'Filme/Started.mp4', positionSeconds: 40, updatedAt: 1000 });

    const before = await getJson(app.baseUrl, '/api/progress?category=movies', cookie);
    assert.equal(before.body.items.length, 1);

    const deleted = await del(app.baseUrl, `/api/progress/${movieId}`, cookie);
    assert.equal(deleted.status, 204);

    const after = await getJson(app.baseUrl, '/api/progress?category=movies', cookie);
    assert.deepEqual(after.body.items, []);
  } finally {
    await app.close();
  }
});

test("DELETE of an in-progress episode whose predecessor is finished turns it into that series' next_up entry", async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', PASSWORD);
    const cookie = await app.login('alice', PASSWORD);
    const { e1, e2 } = seedShow(app.db, 'C');
    seedProgress(app.db, { relPath: e1.relPath, finished: true, positionSeconds: 1400, updatedAt: 1000 });
    seedProgress(app.db, { relPath: e2.relPath, positionSeconds: 40, updatedAt: 2000 });

    const before = await getJson(app.baseUrl, '/api/progress?category=series', cookie);
    assert.deepEqual(
      before.body.items.map((/** @type {any} */ item) => [item.itemId, item.state]),
      [[e2.id, 'in_progress']],
    );

    const deleted = await del(app.baseUrl, `/api/progress/${e2.id}`, cookie);
    assert.equal(deleted.status, 204);

    const after = await getJson(app.baseUrl, '/api/progress?category=series', cookie);
    assert.deepEqual(
      after.body.items.map((/** @type {any} */ item) => [item.itemId, item.state, item.position]),
      [[e2.id, 'next_up', 0]],
    );
  } finally {
    await app.close();
  }
});
