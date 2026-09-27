// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { upsertItem } from '../../src/db/library-repo.js';
import { startTestApp } from '../helpers/app.js';

/** @typedef {import('../../src/db/library-repo.js').LibraryItemInput} LibraryItemInput */

/**
 * @param {Partial<LibraryItemInput>} overrides
 * @returns {LibraryItemInput}
 */
function makeItem(overrides = {}) {
  return /** @type {LibraryItemInput} */ ({
    rel_path: 'Filme/Movie.mp4',
    dir: 'Filme',
    category: 'movies',
    kind: 'video',
    ext: 'mp4',
    title: 'Movie',
    sort_title: 'movie',
    playable: true,
    size: 0,
    mtime_ms: 1,
    scan_version: 1,
    ...overrides,
  });
}

/**
 * Writes real bytes under the app's `mediaRoot` at `relPath`, creating parent
 * directories as needed — the route opens and streams real files.
 * @param {Awaited<ReturnType<typeof startTestApp>>} app
 * @param {string} relPath
 * @param {Buffer} bytes
 * @returns {Promise<void>}
 */
async function writeMediaFile(app, relPath, bytes) {
  const full = path.join(app.config.mediaRoot, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, bytes);
}

/**
 * `size` bytes, `value[i] = i % 256`, so byte-exact range checks are trivial.
 * @param {number} [size]
 * @returns {Buffer}
 */
function patternBytes(size = 50) {
  return Buffer.from(Array.from({ length: size }, (_, i) => i % 256));
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
 * @param {Awaited<ReturnType<typeof startTestApp>>} app
 * @param {string} cookie
 * @param {number | string} id
 * @param {Record<string, string>} [headers]
 * @returns {Promise<Response>}
 */
function getMedia(app, cookie, id, headers = {}) {
  return fetch(`${app.baseUrl}/media/${id}`, { headers: { Cookie: cookie, ...headers } });
}

/**
 * @param {Awaited<ReturnType<typeof startTestApp>>} app
 * @param {string} cookie
 * @param {number | string} id
 * @param {number | string} n
 * @returns {Promise<Response>}
 */
function getSubtitle(app, cookie, id, n) {
  return fetch(`${app.baseUrl}/media/${id}/subtitles/${n}`, { headers: { Cookie: cookie } });
}

test('GET /media/:id and /media/:id/subtitles/0: unauthenticated answers 401 JSON and streams no bytes', async () => {
  const { app } = await setup();
  try {
    for (const pathname of ['/media/1', '/media/1/subtitles/0']) {
      const res = await fetch(`${app.baseUrl}${pathname}`);
      assert.equal(res.status, 401, pathname);
      assert.deepEqual(JSON.parse(await res.text()), { error: 'unauthorized' }, pathname);
    }
  } finally {
    await app.close();
  }
});

test('GET /media/:id: malformed or oversized ids answer 404', async () => {
  const { app, cookie } = await setup();
  try {
    for (const bad of ['abc', '0', '01', '12345678901234567']) {
      assert.equal((await getMedia(app, cookie, bad)).status, 404, `id "${bad}"`);
    }
  } finally {
    await app.close();
  }
});

test('GET /media/:id: unknown id answers 404 not_found', async () => {
  const { app, cookie } = await setup();
  try {
    const res = await getMedia(app, cookie, 999999);
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(await res.text()), { error: 'not_found' });
  } finally {
    await app.close();
  }
});

test('GET /media/:id: non-playable item answers 404 not_playable', async () => {
  const { app, cookie } = await setup();
  try {
    const id = upsertItem(app.db, makeItem({ playable: false }), 1000);
    const res = await getMedia(app, cookie, id);
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(await res.text()), { error: 'not_playable' });
  } finally {
    await app.close();
  }
});

test('GET /media/:id: an indexed item whose file was deleted answers 404 not_found', async () => {
  const { app, cookie } = await setup();
  try {
    await writeMediaFile(app, 'Filme/Gone.mp4', patternBytes());
    const id = upsertItem(app.db, makeItem({ rel_path: 'Filme/Gone.mp4', title: 'Gone', sort_title: 'gone' }), 1000);
    await rm(path.join(app.config.mediaRoot, 'Filme/Gone.mp4'));

    const res = await getMedia(app, cookie, id);
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(await res.text()), { error: 'not_found' });
  } finally {
    await app.close();
  }
});

test('GET /media/:id: happy 200/206/416, Content-Type from compat, HEAD has no body', async () => {
  const { app, cookie } = await setup();
  try {
    const bytes = patternBytes(50);
    await writeMediaFile(app, 'Filme/Movie.mp4', bytes);
    const id = upsertItem(app.db, makeItem(), 1000);

    const full = await getMedia(app, cookie, id);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.equal(full.headers.get('accept-ranges'), 'bytes');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);

    const ranged = await getMedia(app, cookie, id, { Range: 'bytes=10-19' });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 10-19/${bytes.length}`);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), bytes.subarray(10, 20));

    const unsatisfiable = await getMedia(app, cookie, id, { Range: 'bytes=1000-2000' });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${bytes.length}`);
    assert.deepEqual(JSON.parse(await unsatisfiable.text()), { error: 'range_not_satisfiable' });

    const head = await fetch(`${app.baseUrl}/media/${id}`, { method: 'HEAD', headers: { Cookie: cookie } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(bytes.length));
    assert.equal(Buffer.from(await head.arrayBuffer()).length, 0);
  } finally {
    await app.close();
  }
});

test('GET /media/:id: a playable video item indexed under images streams', async () => {
  const { app, cookie } = await setup();
  try {
    const bytes = patternBytes(20);
    await writeMediaFile(app, 'Bilder/clip.mp4', bytes);
    const id = upsertItem(
      app.db,
      makeItem({ rel_path: 'Bilder/clip.mp4', dir: 'Bilder', category: 'images', title: 'clip', sort_title: 'clip' }),
      1000
    );

    const res = await getMedia(app, cookie, id);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
  } finally {
    await app.close();
  }
});

test('POST /media/:id answers 405', async () => {
  const { app, cookie } = await setup();
  try {
    const res = await fetch(`${app.baseUrl}/media/1`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(res.status, 405);
  } finally {
    await app.close();
  }
});

test('GET /media/:id/subtitles/:n: 200 text/vtt for a sidecar; out-of-range, leading-zero and non-video answer 404', async () => {
  const { app, cookie } = await setup();
  try {
    await writeMediaFile(app, 'Filme/Show.mp4', patternBytes(10));
    const vttBytes = Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHallo\n', 'utf8');
    await writeMediaFile(app, 'Filme/Show.de.vtt', vttBytes);
    const videoId = upsertItem(app.db, makeItem({ rel_path: 'Filme/Show.mp4', title: 'Show', sort_title: 'show' }), 1000);

    const res = await getSubtitle(app, cookie, videoId, 0);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/vtt; charset=utf-8');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), vttBytes);

    assert.equal((await getSubtitle(app, cookie, videoId, 1)).status, 404, 'n out of range');
    assert.equal((await getSubtitle(app, cookie, videoId, '01')).status, 404, 'leading zero');

    const audioId = upsertItem(
      app.db,
      makeItem({
        rel_path: 'Musik/Song.mp3',
        dir: 'Musik',
        category: 'music',
        kind: 'audio',
        ext: 'mp3',
        title: 'Song',
        sort_title: 'song',
      }),
      1000
    );
    assert.equal((await getSubtitle(app, cookie, audioId, 0)).status, 404, 'non-video item');
  } finally {
    await app.close();
  }
});

test('GET /media/:id/subtitles/:n: malformed or unknown id answers 404', async () => {
  const { app, cookie } = await setup();
  try {
    for (const bad of ['abc', '0', '01']) {
      assert.equal((await getSubtitle(app, cookie, bad, 0)).status, 404, `id "${bad}"`);
    }
    assert.equal((await getSubtitle(app, cookie, 999999, 0)).status, 404, 'unknown id');
  } finally {
    await app.close();
  }
});
