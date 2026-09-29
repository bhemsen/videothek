// @ts-check

/**
 * `GET /media/:id` serving a fresh converted copy from `CONVERT_DIR`
 * (docs/specs/spec-conversion-core.md, "Serving"). Complements
 * `test/api/media.test.js` (the unconverted-item route), which stays
 * unchanged.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { upsertItem } from '../../src/db/library-repo.js';
import { enqueueConversion, publishConversion } from '../../src/db/conversions.js';
import { startTestApp } from '../helpers/app.js';

/** @typedef {import('../../src/db/library-repo.js').LibraryItemInput} LibraryItemInput */

const SOURCE_REL = 'Filme/Show (2020).mkv';
const SOURCE_SIZE = 1234;
const SOURCE_MTIME = 1_700_000_000_000;
const STORAGE_KEY = 'a'.repeat(64);

/**
 * @param {Partial<LibraryItemInput>} overrides
 * @returns {LibraryItemInput}
 */
function makeItem(overrides = {}) {
  return /** @type {LibraryItemInput} */ ({
    rel_path: SOURCE_REL,
    dir: 'Filme',
    category: 'movies',
    kind: 'video',
    ext: 'mkv',
    title: 'Show',
    sort_title: 'show',
    playable: false,
    size: SOURCE_SIZE,
    mtime_ms: SOURCE_MTIME,
    scan_version: 1,
    ...overrides,
  });
}

/**
 * `size` bytes, `value[i] = (i + seed) % 256`, so two buffers of the same
 * length are still trivially distinguishable (source vs. converted copy).
 * @param {number} size
 * @param {number} [seed]
 * @returns {Buffer}
 */
function patternBytes(size, seed = 0) {
  return Buffer.from(Array.from({ length: size }, (_, i) => (i + seed) % 256));
}

/**
 * @param {string} fullPath
 * @param {Buffer} bytes
 * @returns {Promise<void>}
 */
async function writeFileDeep(fullPath, bytes) {
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, bytes);
}

/**
 * Boots the app and logs one user in.
 * @returns {Promise<{ app: Awaited<ReturnType<typeof startTestApp>>, cookie: string }>}
 */
async function setup() {
  const app = await startTestApp();
  await app.createUser('alice', 'password123');
  const cookie = await app.login('alice', 'password123');
  return { app, cookie };
}

/**
 * Seeds `SOURCE_REL` under `MEDIA_ROOT` and publishes a fresh `playable`
 * conversions row for it, so `upsertItem`'s effective-playable computation
 * marks the item playable even though its own `playable` column is `false`.
 * The converted copy's bytes are written under `CONVERT_DIR` only when
 * `outputBytes` is given, so a caller can simulate a fresh row whose file
 * was removed by omitting it.
 * @param {Awaited<ReturnType<typeof startTestApp>>} app
 * @param {{ sourceBytes: Buffer, outputRel: string, outputBytes?: Buffer, now?: number }} opts
 * @returns {Promise<number>} the item's id
 */
async function seedConvertedItem(app, { sourceBytes, outputRel, outputBytes, now = 1000 }) {
  await writeFileDeep(path.join(app.config.mediaRoot, SOURCE_REL), sourceBytes);
  const id = upsertItem(app.db, makeItem(), now);
  enqueueConversion(app.db, {
    relPath: SOURCE_REL,
    storageKey: STORAGE_KEY,
    target: 'web',
    sourceSize: SOURCE_SIZE,
    sourceMtimeMs: SOURCE_MTIME,
    now,
  });
  publishConversion(app.db, {
    relPath: SOURCE_REL,
    outputRel,
    outputSize: outputBytes ? outputBytes.length : 0,
    notes: '[]',
    now,
  });
  if (outputBytes) {
    await writeFileDeep(path.join(app.config.convertDir, outputRel), outputBytes);
  }
  return id;
}

/**
 * @param {Awaited<ReturnType<typeof startTestApp>>} app
 * @param {string} cookie
 * @param {number} id
 * @param {Record<string, string>} [headers]
 * @returns {Promise<Response>}
 */
function getMedia(app, cookie, id, headers = {}) {
  return fetch(`${app.baseUrl}/media/${id}`, { headers: { Cookie: cookie, ...headers } });
}

test('GET /media/:id: a converted item streams the fresh copy, not the source, with the copy\'s own MIME type', async () => {
  const { app, cookie } = await setup();
  try {
    const sourceBytes = patternBytes(50, 0);
    const outputBytes = patternBytes(30, 99);
    const outputRel = `${STORAGE_KEY}/web.mp4`;
    const id = await seedConvertedItem(app, { sourceBytes, outputRel, outputBytes });

    const full = await getMedia(app, cookie, id);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), outputBytes, 'streams the copy, not the source');

    const ranged = await getMedia(app, cookie, id, { Range: 'bytes=5-9' });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 5-9/${outputBytes.length}`);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), outputBytes.subarray(5, 10));

    const unsatisfiable = await getMedia(app, cookie, id, { Range: `bytes=${outputBytes.length + 10}-${outputBytes.length + 20}` });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${outputBytes.length}`);

    const head = await fetch(`${app.baseUrl}/media/${id}`, { method: 'HEAD', headers: { Cookie: cookie } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(outputBytes.length));
    assert.equal(Buffer.from(await head.arrayBuffer()).length, 0);

    const sourceOnDisk = await readFile(path.join(app.config.mediaRoot, SOURCE_REL));
    assert.deepEqual(sourceOnDisk, sourceBytes, 'the original under MEDIA_ROOT is byte-identical afterwards');
  } finally {
    await app.close();
  }
});

test('GET /media/:id: a stale copy (source changed since conversion) answers 404 not_playable', async () => {
  const { app, cookie } = await setup();
  try {
    const outputBytes = patternBytes(20, 5);
    const id = await seedConvertedItem(app, {
      sourceBytes: patternBytes(50, 0),
      outputRel: `${STORAGE_KEY}/web.mp4`,
      outputBytes,
    });

    // Simulate a rescan that finds the source changed: the conversions row
    // still records the old stat, so the effective-playable computation in
    // `upsertItem` no longer counts it, and the item's own `playable` stays
    // false (no direct-play codec either).
    upsertItem(app.db, makeItem({ size: SOURCE_SIZE + 1, mtime_ms: SOURCE_MTIME + 1 }), 2000);

    const res = await getMedia(app, cookie, id);
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(await res.text()), { error: 'not_playable' });
  } finally {
    await app.close();
  }
});

test('GET /media/:id: a fresh row whose copy file was removed answers 404 not_found', async () => {
  const { app, cookie } = await setup();
  try {
    const id = await seedConvertedItem(app, {
      sourceBytes: patternBytes(50, 0),
      outputRel: `${STORAGE_KEY}/web.mp4`,
      // outputBytes omitted: the row is fresh and playable, but no file
      // exists under CONVERT_DIR (deleted by hand).
    });

    const res = await getMedia(app, cookie, id);
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(await res.text()), { error: 'not_found' });
  } finally {
    await app.close();
  }
});

test('GET /media/:id: an output_rel tampered to escape CONVERT_DIR answers 404 (containment)', async () => {
  const { app, cookie } = await setup();
  try {
    let variant = 0;
    for (const badOutputRel of ['../evil.mp4', '/evil.mp4']) {
      variant += 1;
      const relPath = `Filme/Tampered ${badOutputRel.replace(/[/.]/g, '_')}.mkv`;
      await writeFileDeep(path.join(app.config.mediaRoot, relPath), patternBytes(10, 0));
      const id = upsertItem(app.db, makeItem({ rel_path: relPath, title: relPath, sort_title: relPath }), 1000);
      enqueueConversion(app.db, {
        relPath,
        storageKey: String(variant).repeat(64),
        target: 'web',
        sourceSize: SOURCE_SIZE,
        sourceMtimeMs: SOURCE_MTIME,
        now: 1000,
      });
      publishConversion(app.db, { relPath, outputRel: badOutputRel, outputSize: 1, notes: '[]', now: 1000 });

      const res = await getMedia(app, cookie, id);
      assert.equal(res.status, 404, badOutputRel);
      assert.deepEqual(JSON.parse(await res.text()), { error: 'not_found' }, badOutputRel);
    }
  } finally {
    await app.close();
  }
});

test('PUT /api/progress/:id: a converted item is resumable (200, not not_resumable)', async () => {
  const { app, cookie } = await setup();
  try {
    const id = await seedConvertedItem(app, {
      sourceBytes: patternBytes(50, 0),
      outputRel: `${STORAGE_KEY}/web.mp4`,
      outputBytes: patternBytes(20, 5),
    });

    const res = await fetch(`${app.baseUrl}/api/progress/${id}`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 10, duration: 100 }),
    });
    assert.equal(res.status, 200);
  } finally {
    await app.close();
  }
});
