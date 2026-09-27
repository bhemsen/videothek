import { test } from 'node:test';
import assert from 'node:assert/strict';
import { upsertItem } from '../../src/db/library-repo.js';
import { upsertAudioMeta } from '../../src/db/audio-meta-repo.js';
import { upsertProgress } from '../../src/db/progress.js';
import { START_THRESHOLD_S } from '../../src/api/progress-rules.js';
import { startTestApp } from '../helpers/app.js';

/**
 * @param {Partial<import('../../src/db/library-repo.js').LibraryItemInput>} overrides
 * @returns {import('../../src/db/library-repo.js').LibraryItemInput}
 */
function makeItem(overrides = {}) {
  return {
    rel_path: 'Hörbücher/Jules Beispiel/Die Reise/01 Datei.mp3',
    dir: 'Hörbücher/Jules Beispiel/Die Reise',
    category: 'audiobooks',
    kind: 'audio',
    ext: 'mp3',
    title: 'Datei',
    sort_title: 'datei',
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
    group_key: 'Hörbücher/Jules Beispiel/Die Reise',
    group_title: 'Die Reise',
    group_artist: 'Jules Beispiel',
    title: 'Datei',
    track_no: 1,
    disc_no: 1,
    tag_artist: null,
    tag_album_artist: null,
    tag_album: null,
    tag_year: null,
    duration_ms: 180_000,
    tag_format: 'id3v2',
    ...overrides,
  };
}

/**
 * Seeds a two-file audiobook ("Die Reise") and returns both item ids.
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ file1: number, file2: number }}
 */
function seedBook(db) {
  const file1 = upsertItem(db, makeItem({ rel_path: 'Hörbücher/Jules Beispiel/Die Reise/01 Datei.mp3' }), 1);
  upsertAudioMeta(db, makeAudioMeta(file1, { title: 'Teil 1', track_no: 1 }));
  const file2 = upsertItem(
    db,
    makeItem({ rel_path: 'Hörbücher/Jules Beispiel/Die Reise/02 Datei.mp3' }),
    1
  );
  upsertAudioMeta(db, makeAudioMeta(file2, { title: 'Teil 2', track_no: 2 }));
  return { file1, file2 };
}

/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {string} [cookie]
 * @returns {Promise<{ status: number, body: any }>}
 */
async function get(baseUrl, path, cookie) {
  const res = await fetch(`${baseUrl}${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}

test('GET /api/audiobooks and GET /api/audiobooks/:id require a session', async () => {
  const app = await startTestApp();
  try {
    const { file1 } = seedBook(app.db);
    assert.deepEqual(await get(app.baseUrl, '/api/audiobooks'), { status: 401, body: { error: 'unauthorized' } });
    assert.deepEqual(await get(app.baseUrl, `/api/audiobooks/${file1}`), {
      status: 401,
      body: { error: 'unauthorized' },
    });
  } finally {
    await app.close();
  }
});

test('GET /api/audiobooks/:id 404s on a malformed, unsafe, unknown, wrong-category or meta-less id', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');
    const { file1 } = seedBook(app.db);

    const musicId = upsertItem(
      app.db,
      makeItem({ rel_path: 'Musik/A/B/01.mp3', dir: 'Musik/A/B', category: 'music' }),
      1
    );
    upsertAudioMeta(app.db, makeAudioMeta(musicId, { group_key: 'Musik/A/B', group_title: 'B', group_artist: 'A' }));

    const noMetaId = upsertItem(
      app.db,
      makeItem({ rel_path: 'Hörbücher/Ohne Meta/01.mp3', dir: 'Hörbücher/Ohne Meta' }),
      1
    );

    const cases = ['abc', '01', '-1', '1.5', '0', '9007199254740993', '999999', String(musicId), String(noMetaId)];
    for (const id of cases) {
      const { status, body } = await get(app.baseUrl, `/api/audiobooks/${id}`, cookie);
      assert.equal(status, 404, `id ${id} expected 404, got ${status}`);
      assert.deepEqual(body, { error: 'not_found' }, `id ${id} body`);
    }
    // Sanity: the seeded book's own id is NOT one of the rejected ones.
    const ok = await get(app.baseUrl, `/api/audiobooks/${file1}`, cookie);
    assert.equal(ok.status, 200);
  } finally {
    await app.close();
  }
});

test('any member id resolves to the same book', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');
    const { file1, file2 } = seedBook(app.db);

    const byFile1 = await get(app.baseUrl, `/api/audiobooks/${file1}`, cookie);
    const byFile2 = await get(app.baseUrl, `/api/audiobooks/${file2}`, cookie);

    assert.equal(byFile1.status, 200);
    assert.equal(byFile2.status, 200);
    assert.equal(byFile1.body.id, byFile2.body.id);
    assert.equal(byFile1.body.id, file1, 'group id = the first member in play order');
    assert.deepEqual(
      byFile1.body.files.map((/** @type {any} */ f) => f.id),
      [file1, file2]
    );
  } finally {
    await app.close();
  }
});

test('GET /api/audiobooks shape: one row per book', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');
    const { file1 } = seedBook(app.db);

    const { status, body } = await get(app.baseUrl, '/api/audiobooks', cookie);
    assert.equal(status, 200);
    assert.equal(body.books.length, 1);
    assert.deepEqual(body.books[0], {
      id: file1,
      title: 'Die Reise',
      author: 'Jules Beispiel',
      coverId: file1,
      fileCount: 2,
      duration: 360,
      state: 'new',
      // Both files have a known meta duration, so the denominator (Σd) is
      // non-zero even though nothing has been played yet: 0/360, not null
      // (fraction is only null when no playable file has a known duration).
      fraction: 0,
      lastPlayedAt: null,
    });
  } finally {
    await app.close();
  }
});

test('GET /api/audiobooks/:id shape: resume, per-file progress, state derived from progress', async () => {
  const app = await startTestApp();
  try {
    const alice = await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');
    const { file1, file2 } = seedBook(app.db);
    upsertProgress(app.db, {
      userId: alice.id,
      relPath: 'Hörbücher/Jules Beispiel/Die Reise/01 Datei.mp3',
      positionSeconds: 45,
      durationSeconds: 180,
      finished: false,
      updatedAt: 1_700_000_000_000,
    });

    const { status, body } = await get(app.baseUrl, `/api/audiobooks/${file1}`, cookie);
    assert.equal(status, 200);
    assert.equal(body.id, file1);
    assert.equal(body.title, 'Die Reise');
    assert.equal(body.author, 'Jules Beispiel');
    assert.equal(body.fileCount, 2);
    assert.equal(body.coverId, file1);
    assert.equal(body.duration, 360);
    assert.equal(body.state, 'in_progress');
    assert.equal(body.fraction, 45 / 360);
    assert.deepEqual(body.resume, { itemId: file1, position: 45 });
    assert.equal(body.lastPlayedAt, new Date(1_700_000_000_000).toISOString());
    assert.deepEqual(body.files, [
      {
        id: file1,
        title: 'Teil 1',
        trackNo: 1,
        discNo: 1,
        duration: 180,
        playable: true,
        ext: 'mp3',
        progress: { position: 45, duration: 180, finished: false },
      },
      {
        id: file2,
        title: 'Teil 2',
        trackNo: 2,
        discNo: 1,
        duration: 180,
        playable: true,
        ext: 'mp3',
        progress: null,
      },
    ]);
  } finally {
    await app.close();
  }
});

test('user isolation: user B never sees user A\'s progress', async () => {
  const app = await startTestApp();
  try {
    const alice = await app.createUser('alice', 'password123');
    await app.createUser('bob', 'password456');
    const bobCookie = await app.login('bob', 'password456');
    const { file1 } = seedBook(app.db);
    upsertProgress(app.db, {
      userId: alice.id,
      relPath: 'Hörbücher/Jules Beispiel/Die Reise/01 Datei.mp3',
      positionSeconds: 90,
      durationSeconds: 180,
      finished: false,
      updatedAt: 1000,
    });

    const asBob = await get(app.baseUrl, `/api/audiobooks/${file1}`, bobCookie);
    assert.equal(asBob.status, 200);
    assert.equal(asBob.body.state, 'new');
    assert.equal(asBob.body.resume.itemId, file1);
    assert.equal(asBob.body.resume.position, 0);
    assert.equal(asBob.body.lastPlayedAt, null);

    const listAsBob = await get(app.baseUrl, '/api/audiobooks', bobCookie);
    assert.equal(listAsBob.body.books[0].state, 'new');
  } finally {
    await app.close();
  }
});
