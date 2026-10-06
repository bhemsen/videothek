/**
 * `POST /api/conversions/:id/cancel` and the `cancelling` entry field
 * (`docs/specs/spec-converter-adapter.md`, "Cancel API"): auth, precondition
 * order, the queued/running/not-cancellable outcomes, idempotence, and
 * `cancelling` in the list and `ids` responses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import path from 'node:path';
import { upsertItem } from '../../src/db/library-repo.js';
import { getConversion } from '../../src/db/conversions.js';
import { createConversionQueue } from '../../src/convert/queue.js';
import { startTestApp } from '../helpers/app.js';
import { request } from '../helpers/auth-http.js';
import { waitUntil } from '../helpers/conversion-queue-fixtures.js';

const PASSWORD = 'ein-sicheres-passwort';
const STUB_PATH = path.resolve('test/helpers/converter-stub.js');

/**
 * @param {string} baseUrl
 * @param {string} method
 * @param {string} pathname
 * @param {string} [cookie]
 * @returns {Promise<{ status: number, body: any }>}
 */
async function call(baseUrl, method, pathname, cookie) {
  const res = await request(baseUrl, method, pathname, { headers: cookie ? { Cookie: cookie } : {} });
  return { status: res.status, body: res.body.length > 0 ? JSON.parse(res.body) : null };
}

/**
 * @param {Awaited<ReturnType<typeof startTestApp>>} app
 * @param {string} relPath
 * @param {boolean} [playable]
 * @returns {Promise<number>} the item's id
 */
async function seedSource(app, relPath, playable = false) {
  const abs = path.join(app.config.mediaRoot, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, 'source bytes for the converter stub');
  const stat = statSync(abs);
  return upsertItem(
    app.db,
    /** @type {any} */ ({
      rel_path: relPath,
      dir: path.dirname(relPath),
      category: 'movies',
      kind: 'video',
      ext: path.extname(relPath).slice(1),
      title: relPath,
      sort_title: relPath,
      playable,
      size: stat.size,
      mtime_ms: Math.trunc(stat.mtimeMs),
      scan_version: 1,
    }),
    Date.now()
  );
}

/**
 * @param {string[]} stubArgs
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
  assert.ok(await queue.start(), 'queue.start() must succeed');
  app.deps.conversions = queue;
  return { app, cookie, queue };
}

test('cancel: 401 without a session, 403 for role user', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('user', PASSWORD, 'user');
    const cookie = await app.login('user', PASSWORD);
    assert.equal((await call(app.baseUrl, 'POST', '/api/conversions/1/cancel')).status, 401);
    const res = await call(app.baseUrl, 'POST', '/api/conversions/1/cancel', cookie);
    assert.equal(res.status, 403);
  } finally {
    await app.close();
  }
});

test('cancel: malformed/unknown id -> 404 (before the 503 check); feature off -> 503', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('admin', PASSWORD, 'admin');
    const cookie = await app.login('admin', PASSWORD);
    for (const id of ['abc', '0', '01', '999']) {
      const res = await call(app.baseUrl, 'POST', `/api/conversions/${id}/cancel`, cookie);
      assert.equal(res.status, 404, id);
      assert.deepEqual(res.body, { error: 'not_found' }, id);
    }
    const itemId = await seedSource(app, 'Filme/off.mkv');
    const res = await call(app.baseUrl, 'POST', `/api/conversions/${itemId}/cancel`, cookie);
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { error: 'conversion_disabled' });
  } finally {
    await app.close();
  }
});

test('cancel: no row, a playable item and a failed row -> 409 not_cancellable', async () => {
  const { app, cookie, queue } = await bootWithQueue(['--mode', 'fail']);
  try {
    const none = await seedSource(app, 'Filme/none.mkv');
    const playable = await seedSource(app, 'Filme/ok.mp4', true);
    for (const id of [none, playable]) {
      const res = await call(app.baseUrl, 'POST', `/api/conversions/${id}/cancel`, cookie);
      assert.equal(res.status, 409, `item ${id}`);
      assert.deepEqual(res.body, { error: 'not_cancellable' });
    }
    const failing = await seedSource(app, 'Filme/fails.mkv');
    assert.equal((await call(app.baseUrl, 'POST', `/api/conversions/${failing}`, cookie)).status, 202);
    await waitUntil(() => getConversion(app.db, 'Filme/fails.mkv')?.status === 'failed', { timeoutMs: 5000 });
    const res = await call(app.baseUrl, 'POST', `/api/conversions/${failing}/cancel`, cookie);
    assert.equal(res.status, 409);
    assert.deepEqual(res.body, { error: 'not_cancellable' });
  } finally {
    await queue.stop();
    await app.close();
  }
});

test('cancel: queued -> 200 failed/cancelled; running -> 202 cancelling (idempotent, in list and ids), then failed/cancelled', async () => {
  const { app, cookie, queue } = await bootWithQueue(['--mode', 'hang']);
  try {
    const running = await seedSource(app, 'Filme/run.mkv');
    const queued = await seedSource(app, 'Filme/wait.mkv');
    assert.equal((await call(app.baseUrl, 'POST', `/api/conversions/${running}`, cookie)).status, 202);
    assert.equal((await call(app.baseUrl, 'POST', `/api/conversions/${queued}`, cookie)).status, 202);

    const q = await call(app.baseUrl, 'POST', `/api/conversions/${queued}/cancel`, cookie);
    assert.equal(q.status, 200);
    assert.equal(q.body.status, 'failed');
    assert.equal(q.body.error, 'cancelled');
    assert.equal(q.body.cancelling, false);

    const first = await call(app.baseUrl, 'POST', `/api/conversions/${running}/cancel`, cookie);
    assert.equal(first.status, 202);
    assert.equal(first.body.status, 'converting');
    assert.equal(first.body.cancelling, true);
    const again = await call(app.baseUrl, 'POST', `/api/conversions/${running}/cancel`, cookie);
    assert.equal(again.status, 202, 'idempotent while pending');

    // The row may already have ended on a fast machine; only assert while still converting.
    const list = await call(app.baseUrl, 'GET', '/api/conversions', cookie);
    const ids = await call(app.baseUrl, 'GET', `/api/conversions?ids=${running},${queued}`, cookie);
    for (const body of [list.body, ids.body]) {
      for (const entry of body.items) {
        assert.equal(typeof entry.cancelling, 'boolean');
        if (entry.itemId === queued) assert.equal(entry.cancelling, false);
        if (entry.itemId === running && entry.status === 'converting') assert.equal(entry.cancelling, true);
      }
    }

    await waitUntil(() => getConversion(app.db, 'Filme/run.mkv')?.status === 'failed', { timeoutMs: 5000 });
    const done = await call(app.baseUrl, 'GET', `/api/conversions?ids=${running}`, cookie);
    assert.equal(done.body.items[0].error, 'cancelled');
    assert.equal(done.body.items[0].cancelling, false, 'cancelling is only true while status is converting');
  } finally {
    await queue.stop();
    await app.close();
  }
});
