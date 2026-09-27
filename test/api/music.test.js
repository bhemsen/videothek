import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertItem } from '../../src/db/library-repo.js';
import { upsertAudioMeta } from '../../src/db/audio-meta-repo.js';
import { upsertProgress } from '../../src/db/progress.js';
import { startTestApp } from '../helpers/app.js';

/**
 * @param {Partial<import('../../src/db/library-repo.js').LibraryItemInput>} overrides
 * @returns {import('../../src/db/library-repo.js').LibraryItemInput}
 */
function makeItem(overrides = {}) {
  return {
    rel_path: 'Musik/Die Beispiele/Unterwegs/01 Titel.mp3',
    dir: 'Musik/Die Beispiele/Unterwegs',
    category: 'music',
    kind: 'audio',
    ext: 'mp3',
    title: 'Titel',
    sort_title: 'titel',
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
    group_key: 'Musik/Die Beispiele/Unterwegs',
    group_title: 'Unterwegs',
    group_artist: 'Die Beispiele',
    title: 'Titel',
    track_no: 1,
    disc_no: 1,
    tag_artist: 'Die Beispiele',
    tag_album_artist: 'Die Beispiele',
    tag_album: 'Unterwegs',
    tag_year: 2020,
    duration_ms: 120_000,
    tag_format: 'id3v2',
    ...overrides,
  };
}

/** @param {Partial<import('../../src/db/progress.js').UpsertProgressInput>} overrides */
function makeProgress(overrides = {}) {
  return {
    userId: 1,
    relPath: 'Musik/Die Beispiele/Unterwegs/01 Titel.mp3',
    positionSeconds: 40,
    durationSeconds: 120,
    finished: false,
    updatedAt: 1000,
    ...overrides,
  };
}

/**
 * Seeds "Unterwegs": two playable tracks (t2 has no meta duration, for the
 * "meta ?? row" fallback) plus one non-playable track (t3), so `trackCount`/
 * `tracks` "include non-playable" is exercised end to end.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ t1: number, t2: number, t3: number }}
 */
function seedUnterwegsAlbum(db) {
  const t1 = upsertItem(db, makeItem(), 1);
  upsertAudioMeta(db, makeAudioMeta(t1));
  const t2 = upsertItem(db, makeItem({ rel_path: 'Musik/Die Beispiele/Unterwegs/02 Zweite.mp3' }), 1);
  upsertAudioMeta(db, makeAudioMeta(t2, { title: 'Zweite', track_no: 2, duration_ms: null }));
  const t3 = upsertItem(
    db,
    makeItem({ rel_path: 'Musik/Die Beispiele/Unterwegs/03 Dritte.wma', ext: 'wma', playable: false }),
    1,
  );
  upsertAudioMeta(db, makeAudioMeta(t3, { title: 'Dritte', track_no: 3, tag_format: null, duration_ms: null }));
  return { t1, t2, t3 };
}

/**
 * @param {string} baseUrl
 * @param {string} pathname
 * @param {string} [cookie]
 */
async function fetchJson(baseUrl, pathname, cookie) {
  const res = await fetch(`${baseUrl}${pathname}`, cookie ? { headers: { Cookie: cookie } } : undefined);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text.length > 0 ? JSON.parse(text) : null };
}

test('GET /api/music and GET /api/music/albums/:id answer 401 without a session', async () => {
  const app = await startTestApp();
  try {
    const overview = await fetchJson(app.baseUrl, '/api/music');
    assert.equal(overview.status, 401);
    assert.deepEqual(overview.body, { error: 'unauthorized' });
    const album = await fetchJson(app.baseUrl, '/api/music/albums/1');
    assert.equal(album.status, 401);
  } finally {
    await app.close();
  }
});

test('GET /api/music: new-user resume is null, Cache-Control is no-store, non-playable tracks are counted', async () => {
  const app = await startTestApp();
  try {
    const { t1 } = seedUnterwegsAlbum(app.db);
    await app.createUser('alice', 'ein-sicheres-passwort');
    const cookie = await app.login('alice', 'ein-sicheres-passwort');

    const { status, headers, body } = await fetchJson(app.baseUrl, '/api/music', cookie);
    assert.equal(status, 200);
    assert.equal(headers.get('cache-control'), 'no-store');
    assert.equal(/** @type {any} */ (body).resume, null);
    assert.deepEqual(/** @type {any} */ (body).artists, [
      { name: 'Die Beispiele', albums: [{ id: t1, title: 'Unterwegs', year: 2020, trackCount: 3, coverId: t1 }] },
    ]);
  } finally {
    await app.close();
  }
});

test('GET /api/music resume: 30 s threshold, finished ignored, latest-wins with the duration fallback', async () => {
  const app = await startTestApp();
  try {
    const { t1, t2 } = seedUnterwegsAlbum(app.db);
    const user = await app.createUser('alice', 'ein-sicheres-passwort');
    const cookie = await app.login('alice', 'ein-sicheres-passwort');

    upsertProgress(app.db, makeProgress({ userId: user.id, positionSeconds: 29, updatedAt: 1000 }));
    let res = await fetchJson(app.baseUrl, '/api/music', cookie);
    assert.equal(/** @type {any} */ (res.body).resume, null, 'a 29 s row must not be offered');

    upsertProgress(app.db, makeProgress({ userId: user.id, positionSeconds: 30, updatedAt: 2000 }));
    res = await fetchJson(app.baseUrl, '/api/music', cookie);
    assert.deepEqual(/** @type {any} */ (res.body).resume, {
      trackId: t1,
      albumId: t1,
      title: 'Titel',
      artist: 'Die Beispiele',
      albumTitle: 'Unterwegs',
      coverId: t1,
      position: 30,
      duration: 120,
      updatedAt: new Date(2000).toISOString(),
    });

    // t2 has no meta duration (falls back to the row's own) and is newer, so it now wins over t1.
    upsertProgress(
      app.db,
      makeProgress({
        userId: user.id,
        relPath: 'Musik/Die Beispiele/Unterwegs/02 Zweite.mp3',
        positionSeconds: 50,
        durationSeconds: 200,
        updatedAt: 5000,
      }),
    );
    res = await fetchJson(app.baseUrl, '/api/music', cookie);
    assert.equal(/** @type {any} */ (res.body).resume.trackId, t2, 'the newer row wins');
    assert.equal(/** @type {any} */ (res.body).resume.duration, 200);

    // Finishing t2 excludes it: the next latest *unfinished* row (t1) resurfaces, not null.
    upsertProgress(
      app.db,
      makeProgress({
        userId: user.id,
        relPath: 'Musik/Die Beispiele/Unterwegs/02 Zweite.mp3',
        positionSeconds: 200,
        durationSeconds: 200,
        finished: true,
        updatedAt: 9000,
      }),
    );
    res = await fetchJson(app.baseUrl, '/api/music', cookie);
    assert.equal(/** @type {any} */ (res.body).resume.trackId, t1, 'a finished row must be ignored');
  } finally {
    await app.close();
  }
});

test("user B never sees user A's progress", async () => {
  const app = await startTestApp();
  try {
    seedUnterwegsAlbum(app.db);
    const alice = await app.createUser('alice', 'ein-sicheres-passwort');
    await app.createUser('bob', 'ein-anderes-passwort');
    const aliceCookie = await app.login('alice', 'ein-sicheres-passwort');
    const bobCookie = await app.login('bob', 'ein-anderes-passwort');
    upsertProgress(app.db, makeProgress({ userId: alice.id, positionSeconds: 40, updatedAt: 1000 }));

    const aliceRes = await fetchJson(app.baseUrl, '/api/music', aliceCookie);
    const bobRes = await fetchJson(app.baseUrl, '/api/music', bobCookie);
    assert.ok(/** @type {any} */ (aliceRes.body).resume);
    assert.equal(/** @type {any} */ (bobRes.body).resume, null);
  } finally {
    await app.close();
  }
});

test('GET /api/music/albums/:id: any member id resolves the same album; shape and per-track duration fallback', async () => {
  const app = await startTestApp();
  try {
    const { t1, t2, t3 } = seedUnterwegsAlbum(app.db);
    const user = await app.createUser('alice', 'ein-sicheres-passwort');
    const cookie = await app.login('alice', 'ein-sicheres-passwort');
    upsertProgress(
      app.db,
      makeProgress({
        userId: user.id,
        relPath: 'Musik/Die Beispiele/Unterwegs/02 Zweite.mp3',
        positionSeconds: 10,
        durationSeconds: 200,
        updatedAt: 1000,
      }),
    );

    const byFirst = await fetchJson(app.baseUrl, `/api/music/albums/${t1}`, cookie);
    const byLast = await fetchJson(app.baseUrl, `/api/music/albums/${t3}`, cookie);
    assert.equal(byFirst.status, 200);
    assert.deepEqual(byFirst.body, byLast.body, 'any member id resolves the same album');

    const album = /** @type {any} */ (byFirst.body);
    assert.equal(album.id, t1);
    assert.equal(album.title, 'Unterwegs');
    assert.equal(album.artist, 'Die Beispiele');
    assert.equal(album.year, 2020);
    assert.equal(album.coverId, t1);
    assert.equal(album.duration, 120, 'album total sums only the known meta durations');
    assert.equal(album.discCount, 1);
    assert.equal(album.tracks.length, 3, 'tracks include the non-playable one');

    assert.equal(album.tracks[0].id, t1);
    assert.equal(album.tracks[0].duration, 120);
    assert.equal(album.tracks[0].playable, true);
    assert.equal(album.tracks[1].id, t2);
    assert.equal(album.tracks[1].duration, 200, "falls back to the user's own progress row duration");
    assert.equal(album.tracks[2].id, t3);
    assert.equal(album.tracks[2].playable, false);
    assert.equal(album.tracks[2].ext, 'wma');
  } finally {
    await app.close();
  }
});

test('GET /api/music/albums/:id answers 404 not_found for malformed, unsafe, unknown, wrong-category and meta-less ids', async () => {
  const app = await startTestApp();
  try {
    seedUnterwegsAlbum(app.db);
    await app.createUser('alice', 'ein-sicheres-passwort');
    const cookie = await app.login('alice', 'ein-sicheres-passwort');

    const noMetaId = upsertItem(app.db, makeItem({ rel_path: 'Musik/NoMeta.mp3', dir: 'Musik' }), 1);
    const bookId = upsertItem(
      app.db,
      makeItem({ rel_path: 'Hörbücher/Autor/Buch/01.mp3', dir: 'Hörbücher/Autor/Buch', category: 'audiobooks' }),
      1,
    );
    upsertAudioMeta(
      app.db,
      makeAudioMeta(bookId, { group_key: 'Hörbücher/Autor/Buch', group_title: 'Buch', group_artist: 'Autor' }),
    );

    const cases = ['abc', '01', '-1', '1.5', '9007199254740993', '999999', String(noMetaId), String(bookId)];
    for (const id of cases) {
      const res = await fetchJson(app.baseUrl, `/api/music/albums/${id}`, cookie);
      assert.equal(res.status, 404, `id ${id}`);
      assert.deepEqual(res.body, { error: 'not_found' }, `id ${id}`);
    }
  } finally {
    await app.close();
  }
});
