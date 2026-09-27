import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { upsertItem, upsertSeries } from '../../src/db/library-repo.js';
import { startTestApp } from '../helpers/app.js';

/**
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} pathname
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, body: string }>}
 */
function request(baseUrl, method, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${pathname}`, { method, headers, agent: false }, (res) => {
      const chunks = /** @type {Buffer[]} */ ([]);
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: /** @type {number} */ (res.statusCode), body: Buffer.concat(chunks).toString('utf8') })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/** @param {Awaited<ReturnType<typeof startTestApp>>} app */
async function sessionCookie(app) {
  await app.createUser('julia', 'ein-sicheres-passwort');
  return app.login('julia', 'ein-sicheres-passwort');
}

/** @param {{ running: boolean, lastCompletedAt: number | null }} status */
function fakeLibrary(status) {
  return { status: () => status };
}

/** @param {Partial<import('../../src/db/library-repo.js').LibraryItemInput>} overrides */
function movie(overrides = {}) {
  return /** @type {import('../../src/db/library-repo.js').LibraryItemInput} */ ({
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
    mtime_ms: 1,
    scan_version: 1,
    ...overrides,
  });
}

test('every library route answers 401 {"error":"unauthorized"} without a session', async () => {
  const app = await startTestApp();
  try {
    for (const path of ['/api/library/movies', '/api/library/series/1', '/api/library/items/1']) {
      const res = await request(app.baseUrl, 'GET', path);
      assert.equal(res.status, 401, path);
      assert.deepEqual(JSON.parse(res.body), { error: 'unauthorized' }, path);
    }
  } finally {
    await app.close();
  }
});

test('GET /api/library/:category -> 404 not_found for an unknown category', async () => {
  const app = await startTestApp();
  try {
    const cookie = await sessionCookie(app);
    const res = await request(app.baseUrl, 'GET', '/api/library/does-not-exist', { Cookie: cookie });
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(res.body), { error: 'not_found' });
  } finally {
    await app.close();
  }
});

test('GET /api/library/:category?sort=bogus -> 400 invalid_sort', async () => {
  const app = await startTestApp();
  try {
    const cookie = await sessionCookie(app);
    const res = await request(app.baseUrl, 'GET', '/api/library/movies?sort=bogus', { Cookie: cookie });
    assert.equal(res.status, 400);
    assert.deepEqual(JSON.parse(res.body), { error: 'invalid_sort' });
  } finally {
    await app.close();
  }
});

test('GET /api/library/movies: shape, sort=title default, scan defaults without an injected library', async () => {
  const app = await startTestApp();
  try {
    upsertItem(app.db, movie(), 1000);
    const cookie = await sessionCookie(app);

    const res = await request(app.baseUrl, 'GET', '/api/library/movies', { Cookie: cookie });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.category, 'movies');
    assert.equal(json.sort, 'title');
    assert.deepEqual(json.scan, { running: false, lastCompletedAt: null });
    assert.equal(json.items.length, 1);
    assert.equal(json.items[0].title, 'Arrival');
    assert.equal(json.items[0].fileName, 'Arrival (2016).mp4');
  } finally {
    await app.close();
  }
});

test('GET /api/library/movies?sort=added reflects an injected fake library.status()', async () => {
  const lastCompletedAt = Date.parse('2026-09-26T10:00:00.000Z');
  const app = await startTestApp({ library: fakeLibrary({ running: true, lastCompletedAt }) });
  try {
    upsertItem(app.db, movie({ rel_path: 'Filme/Old.mp4' }), 1000);
    upsertItem(app.db, movie({ rel_path: 'Filme/New.mp4' }), 2000);
    const cookie = await sessionCookie(app);

    const res = await request(app.baseUrl, 'GET', '/api/library/movies?sort=added', { Cookie: cookie });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.sort, 'added');
    assert.deepEqual(json.scan, { running: true, lastCompletedAt: '2026-09-26T10:00:00.000Z' });
    assert.deepEqual(json.items.map((/** @type {{ fileName: string }} */ i) => i.fileName), ['New.mp4', 'Old.mp4']);
  } finally {
    await app.close();
  }
});

test('GET /api/library/series lists series with counts and addedAt = max episode added_at', async () => {
  const app = await startTestApp();
  try {
    const seriesId = upsertSeries(app.db, { series_key: 'Dark', title: 'Dark', sort_title: 'dark', year: 2017 }, 100);
    upsertItem(
      app.db,
      movie({
        rel_path: 'Serien/Dark/S1E1.mp4',
        dir: 'Serien/Dark',
        category: 'series',
        series_id: seriesId,
        series_title: 'Dark',
        season: 1,
        episode: 1,
      }),
      1000
    );
    upsertItem(
      app.db,
      movie({
        rel_path: 'Serien/Dark/S1E2.mp4',
        dir: 'Serien/Dark',
        category: 'series',
        series_id: seriesId,
        series_title: 'Dark',
        season: 1,
        episode: 2,
        playable: false,
      }),
      2000
    );
    const cookie = await sessionCookie(app);

    const res = await request(app.baseUrl, 'GET', '/api/library/series', { Cookie: cookie });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.category, 'series');
    assert.equal(json.series.length, 1);
    const [series] = json.series;
    assert.equal(series.id, seriesId);
    assert.equal(series.seasonCount, 1);
    assert.equal(series.episodeCount, 2);
    assert.equal(series.playableCount, 1);
    assert.equal(series.addedAt, new Date(2000).toISOString());
  } finally {
    await app.close();
  }
});

test('GET /api/library/series/:id: seasons ordered 1..n, 0, null; malformed/unknown id -> 404', async () => {
  const app = await startTestApp();
  try {
    const seriesId = upsertSeries(app.db, { series_key: 'Dark', title: 'Dark', sort_title: 'dark', year: 2017 }, 100);
    upsertItem(
      app.db,
      movie({ rel_path: 'Serien/Dark/S0E1.mp4', dir: 'Serien/Dark', category: 'series', series_id: seriesId, series_title: 'Dark', season: 0, episode: 1 }),
      100
    );
    upsertItem(
      app.db,
      movie({ rel_path: 'Serien/Dark/S1E1.mp4', dir: 'Serien/Dark', category: 'series', series_id: seriesId, series_title: 'Dark', season: 1, episode: 1 }),
      200
    );
    const cookie = await sessionCookie(app);

    const ok = await request(app.baseUrl, 'GET', `/api/library/series/${seriesId}`, { Cookie: cookie });
    assert.equal(ok.status, 200);
    const json = JSON.parse(ok.body);
    assert.deepEqual(json.seasons.map((/** @type {{ season: number | null }} */ s) => s.season), [1, 0]);
    assert.equal(json.seasons[0].episodes[0].season, 1);

    const unknown = await request(app.baseUrl, 'GET', '/api/library/series/999999', { Cookie: cookie });
    assert.equal(unknown.status, 404);
    assert.deepEqual(JSON.parse(unknown.body), { error: 'not_found' });

    const malformed = await request(app.baseUrl, 'GET', '/api/library/series/not-a-number', { Cookie: cookie });
    assert.equal(malformed.status, 404);
  } finally {
    await app.close();
  }
});

test('GET /api/library/items/:id: returns the item JSON; malformed/unknown id -> 404', async () => {
  const app = await startTestApp();
  try {
    const id = upsertItem(app.db, movie(), 1000);
    const cookie = await sessionCookie(app);

    const ok = await request(app.baseUrl, 'GET', `/api/library/items/${id}`, { Cookie: cookie });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).title, 'Arrival');

    const unknown = await request(app.baseUrl, 'GET', '/api/library/items/999999', { Cookie: cookie });
    assert.equal(unknown.status, 404);

    const malformed = await request(app.baseUrl, 'GET', '/api/library/items/0', { Cookie: cookie });
    assert.equal(malformed.status, 404);
  } finally {
    await app.close();
  }
});

test('no relPath/dir leaks into any library response', async () => {
  const app = await startTestApp();
  try {
    const seriesId = upsertSeries(app.db, { series_key: 'Dark', title: 'Dark', sort_title: 'dark', year: 2017 }, 100);
    const id = upsertItem(
      app.db,
      movie({ rel_path: 'Serien/Dark/S1E1.mp4', dir: 'Serien/Dark', category: 'series', series_id: seriesId, series_title: 'Dark', season: 1, episode: 1 }),
      100
    );
    const cookie = await sessionCookie(app);

    for (const path of [`/api/library/series/${seriesId}`, `/api/library/items/${id}`, '/api/library/series']) {
      const res = await request(app.baseUrl, 'GET', path, { Cookie: cookie });
      assert.ok(!res.body.includes('relPath'), path);
      assert.ok(!res.body.includes('rel_path'), path);
      assert.ok(!/"dir"\s*:/.test(res.body), path);
    }
  } finally {
    await app.close();
  }
});
