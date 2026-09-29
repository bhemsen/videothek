/**
 * `GET /api/conversions` and the shared admin/id/origin/disabled precondition
 * checks of `POST /api/conversions/:id` (`src/api/conversions.js`). None of
 * these cases need a running queue: the disabled path leaves `deps.conversions`
 * unset (its default, absent state), and the `GET` listing reads
 * `src/db/conversions.js`/`conversion-queries.js` rows directly. The POST
 * cases that DO need a live, stub-backed queue (not-convertible, already
 * playable, idempotent claim, retry, stale re-queue) live in
 * `conversions-post.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { upsertItem } from '../../src/db/library-repo.js';
import { enqueueConversion, failConversion, publishConversion } from '../../src/db/conversions.js';
import { storageKey } from '../../src/convert/targets.js';
import { startTestApp } from '../helpers/app.js';
import { request } from '../helpers/auth-http.js';

const PASSWORD = 'ein-sicheres-passwort';
const NOW = 1_700_000_100_000;

/**
 * @param {Partial<import('../../src/db/library-repo.js').LibraryItemInput>} overrides
 * @returns {import('../../src/db/library-repo.js').LibraryItemInput}
 */
function movie(overrides = {}) {
  return /** @type {import('../../src/db/library-repo.js').LibraryItemInput} */ ({
    rel_path: 'Filme/Item.mkv',
    dir: 'Filme',
    category: 'movies',
    kind: 'video',
    ext: 'mkv',
    title: 'Item',
    sort_title: 'item',
    playable: false,
    size: 1000,
    mtime_ms: 1,
    scan_version: 1,
    ...overrides,
  });
}

/**
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} pathname
 * @param {{ cookie?: string, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ status: number, body: any }>}
 */
async function call(baseUrl, method, pathname, { cookie, headers = {} } = {}) {
  const res = await request(baseUrl, method, pathname, { headers: cookie ? { Cookie: cookie, ...headers } : headers });
  return { status: res.status, body: res.body.length > 0 ? JSON.parse(res.body) : null };
}

/**
 * Boots the app and logs an admin and a plain user in.
 * @returns {Promise<{ app: Awaited<ReturnType<typeof startTestApp>>, adminCookie: string, userCookie: string }>}
 */
async function setup() {
  const app = await startTestApp({ now: () => NOW });
  await app.createUser('admin', PASSWORD, 'admin');
  await app.createUser('alice', PASSWORD, 'user');
  const adminCookie = await app.login('admin', PASSWORD);
  const userCookie = await app.login('alice', PASSWORD);
  return { app, adminCookie, userCookie };
}

test('GET and POST /api/conversions: 401 without a session, 403 for a non-admin user', async () => {
  const { app, userCookie } = await setup();
  try {
    const id = upsertItem(app.db, movie(), NOW);
    for (const [method, path] of /** @type {const} */ ([
      ['GET', '/api/conversions'],
      ['POST', `/api/conversions/${id}`],
    ])) {
      const anon = await call(app.baseUrl, method, path);
      assert.equal(anon.status, 401, `${method} ${path} without a session`);
      assert.deepEqual(anon.body, { error: 'unauthorized' });

      const user = await call(app.baseUrl, method, path, { cookie: userCookie });
      assert.equal(user.status, 403, `${method} ${path} for a non-admin user`);
      assert.deepEqual(user.body, { error: 'forbidden' });
    }
  } finally {
    await app.close();
  }
});

test('POST /api/conversions/:id: a foreign Origin -> 403 forbidden_origin, no row written', async () => {
  const { app, adminCookie } = await setup();
  try {
    const id = upsertItem(app.db, movie(), NOW);
    const res = await request(app.baseUrl, 'POST', `/api/conversions/${id}`, {
      headers: { Cookie: adminCookie, Origin: 'https://evil.example' },
    });
    assert.equal(res.status, 403);
    assert.deepEqual(JSON.parse(res.body), { error: 'forbidden_origin' });
  } finally {
    await app.close();
  }
});

test('POST /api/conversions/:id: a malformed or unknown id -> 404 not_found', async () => {
  const { app, adminCookie } = await setup();
  try {
    const knownId = upsertItem(app.db, movie(), NOW);
    for (const bad of ['0', '-1', 'abc', '01', String(knownId + 1000)]) {
      const res = await call(app.baseUrl, 'POST', `/api/conversions/${bad}`, { cookie: adminCookie });
      assert.equal(res.status, 404, bad);
      assert.deepEqual(res.body, { error: 'not_found' }, bad);
    }
  } finally {
    await app.close();
  }
});

test('feature disabled (no deps.conversions): POST -> 503 conversion_disabled, GET reports enabled: false', async () => {
  const { app, adminCookie } = await setup();
  try {
    const id = upsertItem(app.db, movie(), NOW);
    const post = await call(app.baseUrl, 'POST', `/api/conversions/${id}`, { cookie: adminCookie });
    assert.equal(post.status, 503);
    assert.deepEqual(post.body, { error: 'conversion_disabled' });

    const get = await call(app.baseUrl, 'GET', '/api/conversions', { cookie: adminCookie });
    assert.equal(get.status, 200);
    assert.equal(get.body.enabled, false);
  } finally {
    await app.close();
  }
});

test('GET /api/conversions?ids=: validation, unknown ids omitted, status "none" with no conversion row', async () => {
  const { app, adminCookie } = await setup();
  try {
    const id = upsertItem(app.db, movie(), NOW);
    for (const bad of ['', 'abc', '1,abc', Array.from({ length: 501 }, (_, i) => i + 1).join(',')]) {
      const res = await call(app.baseUrl, 'GET', `/api/conversions?ids=${encodeURIComponent(bad)}`, { cookie: adminCookie });
      assert.equal(res.status, 400, JSON.stringify(bad).slice(0, 40));
      assert.deepEqual(res.body, { error: 'invalid_query' });
    }

    const unknownId = id + 1000;
    const res = await call(app.baseUrl, 'GET', `/api/conversions?ids=${id},${unknownId}`, { cookie: adminCookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1, 'the unknown id is omitted');
    assert.equal(res.body.items[0].itemId, id);
    assert.equal(res.body.items[0].status, 'none', 'no conversions row at all');
    assert.equal(res.body.items[0].position, null);
  } finally {
    await app.close();
  }
});

test('GET /api/conversions: position counts waiting rows only, group ordering, ids subset keeps the full position, usage incl. freeBytes', async () => {
  const { app, adminCookie } = await setup();
  try {
    mkdirSync(app.config.convertDir, { recursive: true });

    const runningId = upsertItem(app.db, movie({ rel_path: 'running.mkv' }), NOW);
    enqueueConversion(app.db, { relPath: 'running.mkv', storageKey: storageKey('running.mkv'), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 1 });
    app.db.prepare("UPDATE conversions SET status = 'converting', started_at = 2 WHERE rel_path = 'running.mkv'").run();

    const queued1Id = upsertItem(app.db, movie({ rel_path: 'q1.mkv' }), NOW);
    enqueueConversion(app.db, { relPath: 'q1.mkv', storageKey: storageKey('q1.mkv'), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 10 });
    const queued2Id = upsertItem(app.db, movie({ rel_path: 'q2.mkv' }), NOW);
    enqueueConversion(app.db, { relPath: 'q2.mkv', storageKey: storageKey('q2.mkv'), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 20 });

    const failedId = upsertItem(app.db, movie({ rel_path: 'failed.mkv' }), NOW);
    enqueueConversion(app.db, { relPath: 'failed.mkv', storageKey: storageKey('failed.mkv'), target: 'web', sourceSize: 1, sourceMtimeMs: 1, now: 5 });
    failConversion(app.db, { relPath: 'failed.mkv', error: 'converter_failed', detail: null, now: 30 });

    const playableItem = movie({ rel_path: 'ok.mkv' });
    const playableId = upsertItem(app.db, playableItem, NOW);
    enqueueConversion(app.db, { relPath: 'ok.mkv', storageKey: storageKey('ok.mkv'), target: 'web', sourceSize: playableItem.size, sourceMtimeMs: playableItem.mtime_ms, now: 6 });
    publishConversion(app.db, { relPath: 'ok.mkv', outputRel: `${storageKey('ok.mkv')}/web.mp4`, outputSize: 500, notes: '[]', now: 40 });

    const res = await call(app.baseUrl, 'GET', '/api/conversions', { cookie: adminCookie });
    assert.equal(res.status, 200);
    /** @type {any[]} */
    const items = res.body.items;
    const statuses = items.map((e) => e.status);
    // converting, then queued (FIFO), then failed, then playable (no stale row here) — group order fixed.
    assert.deepEqual(statuses, ['converting', 'queued', 'queued', 'failed', 'playable']);
    const byId = new Map(items.map((e) => [e.itemId, e]));
    assert.equal(byId.get(runningId).position, null, 'the running job is not counted');
    assert.equal(byId.get(queued1Id).position, 1);
    assert.equal(byId.get(queued2Id).position, 2);
    assert.equal(byId.get(failedId).position, null);
    assert.equal(byId.get(playableId).position, null);

    const subset = await call(app.baseUrl, 'GET', `/api/conversions?ids=${queued2Id}`, { cookie: adminCookie });
    assert.equal(subset.body.items[0].position, 2, 'position is numbered over all visible rows, not just the requested subset');

    assert.equal(res.body.usage.count, 1);
    assert.equal(res.body.usage.bytes, 500);
    assert.equal(typeof res.body.usage.freeBytes, 'number');
    assert.ok(res.body.usage.freeBytes > 0);
  } finally {
    await app.close();
  }
});
