/**
 * `POST /api/conversions/:id` paths that need a real, running, stub-backed
 * queue (`docs/specs/archive/spec-conversion-core.md`, "POST order"): the
 * not-convertible/already-playable preconditions, the idempotent claim of an
 * already `queued`/`converting` row, a retry after `failed`, and re-queueing
 * a `stale` copy. The pure id/origin/auth/disabled cases that need no queue
 * at all live in `conversions.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { upsertItem } from '../../src/db/library-repo.js';
import { enqueueConversion, getConversion, publishConversion } from '../../src/db/conversions.js';
import { storageKey } from '../../src/convert/targets.js';
import { createConversionQueue } from '../../src/convert/queue.js';
import { startTestApp } from '../helpers/app.js';
import { request } from '../helpers/auth-http.js';
import { waitUntil } from '../helpers/conversion-queue-fixtures.js';

const PASSWORD = 'ein-sicheres-passwort';
const STUB_PATH = path.resolve('test/helpers/converter-stub.js');

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
    size: 0,
    mtime_ms: 0,
    scan_version: 1,
    ...overrides,
  });
}

/**
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} pathname
 * @param {string} cookie
 * @returns {Promise<{ status: number, body: any }>}
 */
async function call(baseUrl, method, pathname, cookie) {
  const res = await request(baseUrl, method, pathname, { headers: { Cookie: cookie } });
  return { status: res.status, body: res.body.length > 0 ? JSON.parse(res.body) : null };
}

/**
 * Boots the app, logs an admin in, and attaches a real, stub-backed queue
 * (`converterEnv: {}` — the stub is spawned through the absolute
 * `process.execPath` and needs no `PATH`, and the job adds its own
 * `TMPDIR`/`TEMP`/`TMP`). A small `killGraceMs` keeps a `hang`-mode test's
 * `queue.stop()` fast. Callers must `await queue.stop()` before `app.close()`.
 * @param {string[]} stubArgs everything after `converter-stub.js`, e.g. `['--mode', 'ok']`
 * @returns {Promise<{ app: Awaited<ReturnType<typeof startTestApp>>, cookie: string, queue: import('../../src/convert/queue.js').ConversionQueue }>}
 */
async function bootWithQueue(stubArgs) {
  const app = await startTestApp();
  await app.createUser('admin', PASSWORD, 'admin');
  const cookie = await app.login('admin', PASSWORD);
  const queue = createConversionQueue({
    db: app.db,
    config: { ...app.config, converterCmd: [process.execPath, STUB_PATH, ...stubArgs], converterEnv: {} },
    log: app.deps.log,
    now: app.deps.now,
    killGraceMs: 300,
  });
  const ok = await queue.start();
  assert.ok(ok, 'queue.start() must succeed');
  app.deps.conversions = queue;
  return { app, cookie, queue };
}

/**
 * Writes a real source file under `MEDIA_ROOT` and its matching
 * `library_items` row, size/mtime taken from the file's own stat so the
 * job's own re-stat never reports `source_changed`.
 * @param {Awaited<ReturnType<typeof bootWithQueue>>['app']} app
 * @param {string} relPath
 * @returns {Promise<number>} the item's id
 */
async function seedSource(app, relPath) {
  const abs = path.join(app.config.mediaRoot, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, 'source bytes for the converter stub');
  const stat = statSync(abs);
  return upsertItem(app.db, movie({ rel_path: relPath, size: stat.size, mtime_ms: Math.trunc(stat.mtimeMs) }), Date.now());
}

test('POST /api/conversions/:id: not_convertible for an image, a gallery video, a .mid file and a zero-byte file; already_playable for a direct-play item', async () => {
  const { app, cookie, queue } = await bootWithQueue(['--mode', 'ok']);
  try {
    const image = upsertItem(app.db, movie({ rel_path: 'Bilder/x.jpg', category: 'images', kind: 'image', ext: 'jpg', size: 100 }), Date.now());
    const galleryVideo = upsertItem(app.db, movie({ rel_path: 'Bilder/clip.mp4', category: 'images', kind: 'video', ext: 'mp4', size: 100 }), Date.now());
    const midi = upsertItem(app.db, movie({ rel_path: 'Musik/x.mid', category: 'music', kind: 'audio', ext: 'mid', size: 100 }), Date.now());
    const zeroByte = upsertItem(app.db, movie({ rel_path: 'Filme/empty.mkv', size: 0 }), Date.now());
    for (const id of [image, galleryVideo, midi, zeroByte]) {
      const res = await call(app.baseUrl, 'POST', `/api/conversions/${id}`, cookie);
      assert.equal(res.status, 400, `item ${id}`);
      assert.deepEqual(res.body, { error: 'not_convertible' }, `item ${id}`);
    }

    const playable = upsertItem(app.db, movie({ rel_path: 'Filme/playable.mp4', ext: 'mp4', playable: true, size: 100 }), Date.now());
    const res = await call(app.baseUrl, 'POST', `/api/conversions/${playable}`, cookie);
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'already_playable' });
  } finally {
    await queue.stop();
    await app.close();
  }
});

test('POST /api/conversions/:id: an idle queue claims at once (202 already reports "converting"); a second item stays queued behind it, and a repeat POST is idempotent (200, unchanged entry)', async () => {
  const { app, cookie, queue } = await bootWithQueue(['--mode', 'hang']);
  try {
    const id1 = await seedSource(app, 'Filme/one.mkv');
    const id2 = await seedSource(app, 'Filme/two.mkv');

    const first = await call(app.baseUrl, 'POST', `/api/conversions/${id1}`, cookie);
    assert.equal(first.status, 202);
    assert.equal(first.body.status, 'converting', 'an idle queue claims synchronously before the 202 body is built');

    const second = await call(app.baseUrl, 'POST', `/api/conversions/${id2}`, cookie);
    assert.equal(second.status, 202);
    assert.equal(second.body.status, 'queued', 'a job is already running, so this one waits');
    assert.equal(second.body.position, 1);

    const repeat = await call(app.baseUrl, 'POST', `/api/conversions/${id2}`, cookie);
    assert.equal(repeat.status, 200, 'idempotent: already queued, not re-queued');
    assert.deepEqual(repeat.body, second.body, 'the entry is unchanged');
  } finally {
    await queue.stop();
    await app.close();
  }
});

test('POST /api/conversions/:id: retry of a failed conversion -> 202, re-queued', async () => {
  const { app, cookie, queue } = await bootWithQueue(['--mode', 'fail']);
  const relPath = 'Filme/fails.mkv';
  try {
    const id = await seedSource(app, relPath);
    const first = await call(app.baseUrl, 'POST', `/api/conversions/${id}`, cookie);
    assert.equal(first.status, 202);

    await waitUntil(() => getConversion(app.db, relPath)?.status === 'failed', { timeoutMs: 5000 });

    const retry = await call(app.baseUrl, 'POST', `/api/conversions/${id}`, cookie);
    assert.equal(retry.status, 202, 'a failed row can be retried');
    const row = getConversion(app.db, relPath);
    assert.ok(row && (row.status === 'queued' || row.status === 'converting'), `unexpected status ${row?.status}`);
  } finally {
    await queue.stop();
    await app.close();
  }
});

test('POST /api/conversions/:id: a stale copy (GET reports "stale") re-queues on POST -> 202', async () => {
  const { app, cookie, queue } = await bootWithQueue(['--mode', 'hang']);
  const relPath = 'Filme/stale.mkv';
  try {
    const abs = path.join(app.config.mediaRoot, relPath);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, 'version one');
    let stat = statSync(abs);
    const id = upsertItem(app.db, movie({ rel_path: relPath, size: stat.size, mtime_ms: Math.trunc(stat.mtimeMs) }), Date.now());
    enqueueConversion(app.db, { relPath, storageKey: storageKey(relPath), target: 'web', sourceSize: stat.size, sourceMtimeMs: Math.trunc(stat.mtimeMs), now: 1 });
    publishConversion(app.db, { relPath, outputRel: `${storageKey(relPath)}/web.mp4`, outputSize: 10, notes: '[]', sidecars: '[]', now: 2 });

    // The source changes after publishing: the stored copy's source stat no
    // longer matches, so the effective-playable computation (and this
    // route's derived status) both go stale.
    await writeFile(abs, 'version two, longer content');
    stat = statSync(abs);
    upsertItem(app.db, movie({ rel_path: relPath, size: stat.size, mtime_ms: Math.trunc(stat.mtimeMs) }), Date.now());

    const before = await call(app.baseUrl, 'GET', `/api/conversions?ids=${id}`, cookie);
    assert.equal(before.body.items[0].status, 'stale');

    const res = await call(app.baseUrl, 'POST', `/api/conversions/${id}`, cookie);
    assert.equal(res.status, 202);
    assert.ok(['queued', 'converting'].includes(res.body.status), `unexpected status ${res.body.status}`);
  } finally {
    await queue.stop();
    await app.close();
  }
});
