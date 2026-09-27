// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { upsertItem } from '../../src/db/library-repo.js';
import { upsertAudioMeta } from '../../src/db/audio-meta-repo.js';
import { buildId3v2Tag, buildFrame, apicFrameBody, buildMpegFrame } from '../helpers/mp3-fixture.js';
import { startTestApp } from '../helpers/app.js';

/**
 * @param {Partial<import('../../src/db/library-repo.js').LibraryItemInput>} overrides
 * @returns {import('../../src/db/library-repo.js').LibraryItemInput}
 */
function makeItem(overrides = {}) {
  return {
    rel_path: 'Musik/Einzeltrack.mp3',
    dir: 'Musik',
    category: 'music',
    kind: 'audio',
    ext: 'mp3',
    title: 'Einzeltrack',
    sort_title: 'einzeltrack',
    playable: true,
    size: 1000,
    mtime_ms: 1_700_000_000_000,
    scan_version: 1,
    ...overrides,
  };
}

/**
 * @param {number} itemId
 * @param {Partial<import('../../src/db/audio-meta-repo.js').AudioMetaInput>} overrides
 * @returns {import('../../src/db/audio-meta-repo.js').AudioMetaInput}
 */
function makeAudioMeta(itemId, overrides = {}) {
  return {
    item_id: itemId,
    meta_version: 1,
    source_mtime_ms: 1_700_000_000_000,
    source_size: 1000,
    group_key: 'Musik',
    group_title: null,
    group_artist: null,
    title: 'Einzeltrack',
    track_no: null,
    disc_no: 1,
    duration_ms: null,
    tag_format: null,
    ...overrides,
  };
}

/**
 * Seeds one `library_items` + `audio_meta` row and, unless `content` is
 * `undefined`, writes the file's real bytes under the app's `mediaRoot`.
 * @param {Awaited<ReturnType<typeof startTestApp>>} app
 * @param {Partial<import('../../src/db/library-repo.js').LibraryItemInput>} itemOverrides
 * @param {Partial<import('../../src/db/audio-meta-repo.js').AudioMetaInput>} metaOverrides
 * @param {Buffer | undefined} content
 * @returns {Promise<number>}
 */
async function seedItem(app, itemOverrides, metaOverrides, content = Buffer.from('x')) {
  const item = makeItem(itemOverrides);
  const itemId = upsertItem(app.db, item, 1);
  upsertAudioMeta(app.db, makeAudioMeta(itemId, metaOverrides));
  if (content !== undefined) {
    const full = path.join(app.config.mediaRoot, ...item.rel_path.split('/'));
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return itemId;
}

/** Builds a loose mp3 with an embedded front-cover APIC and returns both the file and the exact embedded picture bytes. */
function buildMp3WithCover() {
  const picture = Buffer.from('fake-jpeg-bytes-embedded-as-the-front-cover');
  const apic = buildFrame({ id: 'APIC', body: apicFrameBody({ mime: 'image/jpeg', pictureType: 3, data: picture }) });
  const file = Buffer.concat([buildId3v2Tag({ frames: [apic] }), buildMpegFrame()]);
  return { file, picture };
}

/** @param {Awaited<ReturnType<typeof startTestApp>>} app @param {string} cookie @param {number|string} id */
function getCover(app, cookie, id, headers = {}) {
  return fetch(`${app.baseUrl}/media/${id}/cover`, { headers: { Cookie: cookie, ...headers } });
}

/** Boots the app and logs a user in. */
async function setup(extra = {}) {
  const app = await startTestApp({ ...extra });
  await app.createUser('alice', 'password123');
  const cookie = await app.login('alice', 'password123');
  return { app, cookie };
}

test('GET /media/:id/cover: embedded picture slice — exact bytes, Content-Length, Content-Type and Cache-Control', async () => {
  const { app, cookie } = await setup();
  try {
    const { file, picture } = buildMp3WithCover();
    const itemId = await seedItem(app, {}, {}, file);
    const res = await getCover(app, cookie, itemId);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('content-length'), String(picture.length));
    assert.equal(res.headers.get('cache-control'), 'private, max-age=86400');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), picture);
  } finally {
    await app.close();
  }
});

test('GET /media/:id/cover: Range/HEAD on the embedded slice are relative to the slice, not the whole file', async () => {
  const { app, cookie } = await setup();
  try {
    const { file, picture } = buildMp3WithCover();
    const itemId = await seedItem(app, {}, {}, file);

    const head = await fetch(`${app.baseUrl}/media/${itemId}/cover`, { method: 'HEAD', headers: { Cookie: cookie } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(picture.length));
    assert.equal(Buffer.from(await head.arrayBuffer()).length, 0);

    const ranged = await getCover(app, cookie, itemId, { Range: 'bytes=0-1' });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 0-1/${picture.length}`);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), picture.subarray(0, 2));

    const tooFar = await getCover(app, cookie, itemId, { Range: `bytes=${picture.length}-${picture.length + 10}` });
    assert.equal(tooFar.status, 416);
    assert.equal(tooFar.headers.get('content-range'), `bytes */${picture.length}`);
  } finally {
    await app.close();
  }
});

test('GET /media/:id/cover: a readPicture ref past EOF answers 404 through sendMedia\'s slice check', async () => {
  const { app, cookie } = await setup({ readPicture: async () => ({ offset: 1_000_000, length: 10, mime: 'image/jpeg' }) });
  try {
    const itemId = await seedItem(app, {}, {}, Buffer.from('short file'));
    assert.equal((await getCover(app, cookie, itemId)).status, 404);
  } finally {
    await app.close();
  }
});

test('GET /media/:id/cover: a folder image "Cover.JPG" is served as image/jpeg (real album directory)', async () => {
  const { app, cookie } = await setup();
  try {
    const dir = 'Musik/Die Beispiele/Unterwegs';
    const itemId = await seedItem(
      app,
      { rel_path: `${dir}/01 Titel.mp3`, dir },
      { group_key: dir, group_title: 'Unterwegs', group_artist: 'Die Beispiele' },
    );
    const coverBytes = Buffer.from('folder-cover-bytes');
    await writeFile(path.join(app.config.mediaRoot, ...dir.split('/'), 'Cover.JPG'), coverBytes);

    const res = await getCover(app, cookie, itemId);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), coverBytes);
  } finally {
    await app.close();
  }
});

test('GET /media/:id/cover: unauthenticated answers 401 JSON, no bytes served', async () => {
  const { app } = await setup();
  try {
    const { file } = buildMp3WithCover();
    const itemId = await seedItem(app, {}, {}, file);
    const res = await fetch(`${app.baseUrl}/media/${itemId}/cover`);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  } finally {
    await app.close();
  }
});

test('GET /media/:id/cover: 404 for every malformed/unsafe id and every failing pre-check', async () => {
  const { app, cookie } = await setup();
  try {
    for (const bad of ['abc', '0', '01', '12345678901234567', '9999999999999999']) {
      assert.equal((await getCover(app, cookie, bad)).status, 404, `id "${bad}"`);
    }

    /** @type {Record<string, () => Promise<number>>} */
    const scenarios = {
      'unknown id': async () => (await seedItem(app, {}, {})) + 1000,
      'not a music/audiobooks item (no audio_meta row)': async () =>
        upsertItem(app.db, makeItem({ rel_path: 'Filme/movie.mp4', dir: 'Filme', category: 'movies', kind: 'video', ext: 'mp4' }), 1),
      'a music item with no cover anywhere (untagged, no folder/sidecar image)': async () => seedItem(app, { rel_path: 'Musik/Ohne Cover.mp3' }, {}),
    };
    for (const [label, seedScenario] of Object.entries(scenarios)) {
      const id = await seedScenario();
      assert.equal((await getCover(app, cookie, id)).status, 404, label);
    }
  } finally {
    await app.close();
  }
});
