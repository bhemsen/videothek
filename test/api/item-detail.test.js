// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '../../src/db/migrate.js';
import { upsertItem, upsertSeries } from '../../src/db/library-repo.js';
import { toItemDetailJson } from '../../src/api/item-detail.js';
import { startTestApp } from '../helpers/app.js';

/** @returns {import('node:sqlite').DatabaseSync} an in-memory DB with every migration applied */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  return db;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Partial<import('../../src/db/library-repo.js').LibraryItemInput>} overrides
 * @returns {import('../../src/db/library-repo.js').LibraryItemRow}
 */
function insertItem(db, overrides) {
  const item = /** @type {import('../../src/db/library-repo.js').LibraryItemInput} */ ({
    rel_path: `Filme/${Math.random()}.mp4`,
    dir: 'Filme',
    category: 'movies',
    kind: 'video',
    ext: 'mp4',
    title: 'Titel',
    sort_title: 'titel',
    playable: true,
    size: 1000,
    mtime_ms: 1_700_000_000_000,
    scan_version: 1,
    ...overrides,
  });
  const id = upsertItem(db, item, 1);
  return /** @type {import('../../src/db/library-repo.js').LibraryItemRow} */ (
    /** @type {unknown} */ (db.prepare('SELECT * FROM library_items WHERE id = ?').get(id))
  );
}

/** @param {string} prefix */
async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * @param {string} root
 * @param {string} relPath '/'-separated, may include directories
 */
async function writeMediaFile(root, relPath) {
  const segments = relPath.split('/');
  const abs = path.join(root, ...segments);
  if (segments.length > 1) await fs.mkdir(path.join(root, ...segments.slice(0, -1)), { recursive: true });
  await fs.writeFile(abs, 'x');
  return abs;
}

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

test('toItemDetailJson: next mirrors the series successor summary; null for a movie', async () => {
  const db = makeDb();
  try {
    const seriesId = upsertSeries(db, { series_key: 'Dark', title: 'Dark', sort_title: 'dark' }, 1);
    const e01 = insertItem(db, {
      series_id: seriesId,
      series_title: 'Dark',
      category: 'series',
      season: 1,
      episode: 1,
      rel_path: 'Serien/Dark/s01e01.mp4',
      dir: 'Serien/Dark',
      title: 'Geheimnisse',
    });
    const e02 = insertItem(db, {
      series_id: seriesId,
      series_title: 'Dark',
      category: 'series',
      season: 1,
      episode: 2,
      episode_end: 3,
      rel_path: 'Serien/Dark/s01e02-03.mp4',
      dir: 'Serien/Dark',
      title: 'Lügen',
    });

    const detail = await toItemDetailJson({ db, mediaRoot: '/does-not-exist', convertDir: '/does-not-exist-either' }, e01);
    assert.deepEqual(detail.next, { id: e02.id, title: 'Lügen', season: 1, episode: 2, episodeEnd: 3 });

    const movie = insertItem(db, { rel_path: 'Filme/Arrival.mp4', title: 'Arrival' });
    const movieDetail = await toItemDetailJson({ db, mediaRoot: '/does-not-exist', convertDir: '/does-not-exist-either' }, movie);
    assert.equal(movieDetail.next, null);
  } finally {
    db.close();
  }
});

test('toItemDetailJson: still includes every toItemJson key alongside next/subtitles', async () => {
  const db = makeDb();
  try {
    const movie = insertItem(db, { rel_path: 'Filme/Arrival.mp4', title: 'Arrival', year: 2016 });
    const detail = await toItemDetailJson({ db, mediaRoot: '/does-not-exist', convertDir: '/does-not-exist-either' }, movie);
    assert.equal(detail.title, 'Arrival');
    assert.equal(detail.year, 2016);
    assert.equal(detail.fileName, 'Arrival.mp4');
  } finally {
    db.close();
  }
});

test('toItemDetailJson: subtitles lists a video\'s sidecars without leaking a path; [] for audio/image rows', async () => {
  const root = await makeTempDir('vt-item-detail-');
  const db = makeDb();
  try {
    await writeMediaFile(root, 'Filme/Arrival.mp4');
    await writeMediaFile(root, 'Filme/Arrival.de.vtt');
    await writeMediaFile(root, 'Filme/Arrival.en.vtt');

    const video = insertItem(db, { rel_path: 'Filme/Arrival.mp4', kind: 'video', title: 'Arrival' });
    const detail = await toItemDetailJson({ db, mediaRoot: root, convertDir: path.join(root, '.convert-none') }, video);
    assert.deepEqual(detail.subtitles, [
      { index: 0, lang: 'de', label: 'de' },
      { index: 1, lang: 'en', label: 'en' },
    ]);
    assert.ok(!JSON.stringify(detail).includes(root), 'no filesystem path leaked into the response');

    const audio = insertItem(db, {
      rel_path: 'Musik/song.flac',
      dir: 'Musik',
      kind: 'audio',
      category: 'music',
      ext: 'flac',
      title: 'Song',
    });
    const audioDetail = await toItemDetailJson({ db, mediaRoot: root, convertDir: path.join(root, '.convert-none') }, audio);
    assert.deepEqual(audioDetail.subtitles, []);

    const image = insertItem(db, {
      rel_path: 'Bilder/urlaub.jpg',
      dir: 'Bilder',
      kind: 'image',
      category: 'images',
      ext: 'jpg',
      title: 'Urlaub',
    });
    const imageDetail = await toItemDetailJson({ db, mediaRoot: root, convertDir: path.join(root, '.convert-none') }, image);
    assert.deepEqual(imageDetail.subtitles, []);
  } finally {
    db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('GET /api/library/items/:id carries next and subtitles; GET /api/library/movies items do not', async () => {
  const app = await startTestApp();
  try {
    await writeMediaFile(app.config.mediaRoot, 'Filme/Arrival (2016).mp4');
    await writeMediaFile(app.config.mediaRoot, 'Filme/Arrival (2016).de.vtt');
    const id = upsertItem(
      app.db,
      /** @type {import('../../src/db/library-repo.js').LibraryItemInput} */ ({
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
      }),
      1000
    );
    const cookie = await sessionCookie(app);

    const detail = await request(app.baseUrl, 'GET', `/api/library/items/${id}`, { Cookie: cookie });
    assert.equal(detail.status, 200);
    const detailJson = JSON.parse(detail.body);
    assert.equal(detailJson.next, null);
    assert.deepEqual(detailJson.subtitles, [{ index: 0, lang: 'de', label: 'de' }]);

    const list = await request(app.baseUrl, 'GET', '/api/library/movies', { Cookie: cookie });
    assert.equal(list.status, 200);
    const listJson = JSON.parse(list.body);
    assert.equal(listJson.items.length, 1);
    assert.equal('next' in listJson.items[0], false);
    assert.equal('subtitles' in listJson.items[0], false);
  } finally {
    await app.close();
  }
});
