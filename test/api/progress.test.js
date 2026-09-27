/**
 * `GET/PUT/DELETE /api/progress/:id` — id validation, the resumable/body/
 * write-rule wiring, per-user isolation and the mutation guard. The
 * collection route (`GET /api/progress`) has its own file
 * (`test/api/progress-list.test.js`); the write-rule and query-parsing pure
 * logic has its own too (`test/api/progress-rules.test.js`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { upsertItem } from '../../src/db/library-repo.js';
import { startTestApp } from '../helpers/app.js';
import { request } from '../helpers/auth-http.js';

const PASSWORD = 'correct-horse-battery';
const NOW = 1_700_000_100_000;

/**
 * @param {Partial<import('../../src/db/library-repo.js').LibraryItemInput>} overrides
 * @returns {import('../../src/db/library-repo.js').LibraryItemInput}
 */
function makeMovie(overrides = {}) {
  return {
    rel_path: 'Filme/Ein Film (2020).mp4',
    dir: 'Filme',
    category: 'movies',
    kind: 'video',
    ext: 'mp4',
    title: 'Ein Film',
    sort_title: 'ein film',
    year: 2020,
    playable: true,
    size: 1000,
    mtime_ms: 1_700_000_000_000,
    scan_version: 1,
    ...overrides,
  };
}

/**
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} pathname
 * @param {{ cookie?: string, json?: unknown, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ status: number, body: any }>}
 */
async function call(baseUrl, method, pathname, { cookie, json, headers = {} } = {}) {
  const res = await request(baseUrl, method, pathname, {
    headers: cookie ? { Cookie: cookie, ...headers } : headers,
    json,
  });
  return { status: res.status, body: res.body.length > 0 ? JSON.parse(res.body) : null };
}

/**
 * `PUT` with a raw body string and content type (the shared `request`
 * helper only ever sends well-formed JSON).
 * @param {string} url
 * @param {string} cookie
 * @param {string} body
 * @param {string} contentType
 * @returns {Promise<{ status: number, body: any }>}
 */
function rawPut(url, cookie, body, contentType) {
  return new Promise((resolve, reject) => {
    const headers = { Cookie: cookie, 'Content-Type': contentType };
    const req = http.request(url, { method: 'PUT', headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => resolve({ status: /** @type {number} */ (res.statusCode), body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('every progress route answers 401 without a session', async () => {
  const app = await startTestApp();
  try {
    const movieId = upsertItem(app.db, makeMovie(), 1);
    assert.equal((await call(app.baseUrl, 'GET', `/api/progress/${movieId}`)).status, 401);
    const put = await call(app.baseUrl, 'PUT', `/api/progress/${movieId}`, { json: { position: 1, duration: 2 } });
    assert.equal(put.status, 401);
    assert.equal((await call(app.baseUrl, 'DELETE', `/api/progress/${movieId}`)).status, 401);
    assert.equal((await call(app.baseUrl, 'GET', '/api/progress')).status, 401);
  } finally {
    await app.close();
  }
});

test('a malformed, unsafe or unknown id answers 404 on every per-item route', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', PASSWORD);
    const cookie = await app.login('alice', PASSWORD);
    const ids = ['abc', '01', '-1', '0', '1.5', '9007199254740993', '999999'];
    for (const id of ids) {
      assert.equal((await call(app.baseUrl, 'GET', `/api/progress/${id}`, { cookie })).status, 404, `GET ${id}`);
      const put = await call(app.baseUrl, 'PUT', `/api/progress/${id}`, { cookie, json: { position: 1, duration: 2 } });
      assert.equal(put.status, 404, `PUT ${id}`);
      assert.equal((await call(app.baseUrl, 'DELETE', `/api/progress/${id}`, { cookie })).status, 404, `DELETE ${id}`);
    }
  } finally {
    await app.close();
  }
});

test('PUT on an image, a video under images or a non-playable item answers 400 not_resumable', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', PASSWORD);
    const cookie = await app.login('alice', PASSWORD);
    const imageId = upsertItem(
      app.db,
      makeMovie({ rel_path: 'Bilder/Urlaub/foto.jpg', dir: 'Bilder/Urlaub', category: 'images', kind: 'image', ext: 'jpg' }),
      1,
    );
    const videoUnderImagesId = upsertItem(
      app.db,
      makeMovie({ rel_path: 'Bilder/Urlaub/clip.mp4', dir: 'Bilder/Urlaub', category: 'images', kind: 'video' }),
      1,
    );
    const nonPlayableId = upsertItem(app.db, makeMovie({ rel_path: 'Filme/Kaputt.avi', ext: 'avi', playable: false }), 1);

    for (const id of [imageId, videoUnderImagesId, nonPlayableId]) {
      const res = await call(app.baseUrl, 'PUT', `/api/progress/${id}`, { cookie, json: { position: 10, duration: 100 } });
      assert.equal(res.status, 400, `id ${id}`);
      assert.deepEqual(res.body, { error: 'not_resumable' });
    }
  } finally {
    await app.close();
  }
});

test('a body-less PUT answers 400 invalid_json', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', PASSWORD);
    const cookie = await app.login('alice', PASSWORD);
    const movieId = upsertItem(app.db, makeMovie(), 1);
    const res = await call(app.baseUrl, 'PUT', `/api/progress/${movieId}`, { cookie });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body, { error: 'invalid_json' });
  } finally {
    await app.close();
  }
});

test('PUT order: id syntax -> readJson codes -> lookup -> not_resumable -> invalid_json -> invalid_progress', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', PASSWORD);
    const cookie = await app.login('alice', PASSWORD);
    const movie = upsertItem(app.db, makeMovie(), 1);
    const image = upsertItem(app.db, makeMovie({ rel_path: 'Bilder/a.jpg', dir: 'Bilder', category: 'images', kind: 'image' }), 1);
    const json = 'application/json';
    /** @type {[string | number, string, string, number, string][]} */
    const cases = [
      ['abc', '{', json, 404, 'not_found'],
      [999999, '{', json, 400, 'invalid_json'],
      [999999, '{}', 'text/plain', 415, 'unsupported_media_type'],
      [999999, 'x'.repeat(20000), json, 413, 'payload_too_large'],
      [999999, '[]', json, 404, 'not_found'],
      [image, '{', json, 400, 'invalid_json'],
      [image, '[]', json, 400, 'not_resumable'],
      [movie, '[]', json, 400, 'invalid_json'],
      [movie, '"x"', json, 400, 'invalid_json'],
      [movie, '{"position":"1","duration":2}', json, 400, 'invalid_progress'],
    ];
    for (const [id, body, type, status, error] of cases) {
      const res = await rawPut(`${app.baseUrl}/api/progress/${id}`, cookie, body, type);
      assert.deepEqual([res.status, res.body], [status, { error }], `${id} ${body.slice(0, 20)} ${type}`);
    }
  } finally {
    await app.close();
  }
});

test('a foreign Origin on PUT is rejected 403 before any write', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', PASSWORD);
    const cookie = await app.login('alice', PASSWORD);
    const movieId = upsertItem(app.db, makeMovie(), 1);
    const res = await call(app.baseUrl, 'PUT', `/api/progress/${movieId}`, {
      cookie,
      json: { position: 10, duration: 100 },
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(res.body, { error: 'forbidden_origin' });

    const after = await call(app.baseUrl, 'GET', `/api/progress/${movieId}`, { cookie });
    assert.equal(after.body.state, 'none');
  } finally {
    await app.close();
  }
});

test("progress is strictly per user: B can neither read nor change A's progress", async () => {
  const app = await startTestApp({ now: () => NOW });
  try {
    await app.createUser('alice', PASSWORD);
    await app.createUser('bob', PASSWORD);
    const aliceCookie = await app.login('alice', PASSWORD);
    const bobCookie = await app.login('bob', PASSWORD);
    const movieId = upsertItem(app.db, makeMovie(), 1);

    const write = await call(app.baseUrl, 'PUT', `/api/progress/${movieId}`, {
      cookie: aliceCookie,
      json: { position: 40, duration: 3600 },
    });
    assert.equal(write.status, 200);
    assert.equal(write.body.state, 'in_progress');

    const bobRead = await call(app.baseUrl, 'GET', `/api/progress/${movieId}`, { cookie: bobCookie });
    assert.deepEqual(bobRead.body, { itemId: movieId, position: 0, duration: null, state: 'none', updatedAt: null });

    const bobDelete = await call(app.baseUrl, 'DELETE', `/api/progress/${movieId}`, { cookie: bobCookie });
    assert.equal(bobDelete.status, 204);

    const aliceStillThere = await call(app.baseUrl, 'GET', `/api/progress/${movieId}`, { cookie: aliceCookie });
    assert.equal(aliceStillThere.body.state, 'in_progress');
    assert.equal(aliceStillThere.body.position, 40);
  } finally {
    await app.close();
  }
});

test('a body-less DELETE answers 204 whether or not a row existed (idempotent)', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', PASSWORD);
    const cookie = await app.login('alice', PASSWORD);
    const movieId = upsertItem(app.db, makeMovie(), 1);

    const first = await request(app.baseUrl, 'DELETE', `/api/progress/${movieId}`, { headers: { Cookie: cookie } });
    assert.equal(first.status, 204);
    assert.equal(first.body, '');

    const second = await request(app.baseUrl, 'DELETE', `/api/progress/${movieId}`, { headers: { Cookie: cookie } });
    assert.equal(second.status, 204);
  } finally {
    await app.close();
  }
});

test('PUT round trip: start, finish, the finished guard, then DELETE resets to none', async () => {
  const app = await startTestApp({ now: () => NOW });
  try {
    await app.createUser('alice', PASSWORD);
    const cookie = await app.login('alice', PASSWORD);
    const movieId = upsertItem(app.db, makeMovie(), 1);

    const started = await call(app.baseUrl, 'PUT', `/api/progress/${movieId}`, {
      cookie,
      json: { position: 40, duration: 3600 },
    });
    assert.deepEqual(started.body, {
      itemId: movieId,
      position: 40,
      duration: 3600,
      state: 'in_progress',
      updatedAt: new Date(NOW).toISOString(),
    });

    const finished = await call(app.baseUrl, 'PUT', `/api/progress/${movieId}`, {
      cookie,
      json: { position: 3400, duration: 3600 },
    });
    assert.equal(finished.body.state, 'finished');

    const peek = await call(app.baseUrl, 'PUT', `/api/progress/${movieId}`, {
      cookie,
      json: { position: 5, duration: 3600 },
    });
    assert.equal(peek.body.state, 'finished');
    assert.equal(peek.body.position, 3400);

    const removed = await call(app.baseUrl, 'DELETE', `/api/progress/${movieId}`, { cookie });
    assert.equal(removed.status, 204);
    const afterDelete = await call(app.baseUrl, 'GET', `/api/progress/${movieId}`, { cookie });
    assert.equal(afterDelete.body.state, 'none');
  } finally {
    await app.close();
  }
});
