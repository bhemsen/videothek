import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedAudio, seedProgress } from '../helpers/home-seed.js';
import { startTestApp } from '../helpers/app.js';

/**
 * Sort/tie-break tests for `GET /api/home/listening`, split off from
 * `home-listening.test.js` to stay under the 300-line file limit.
 */

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

/**
 * Seeds a two-file, 180s-per-file audiobook. See `home-listening.test.js`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ groupKey: string, title?: string, author?: string, addedAt?: number }} params
 * @returns {{ file1: number, file2: number, path1: string, path2: string }}
 */
function seedBook(db, { groupKey, title = 'Buch', author = 'Autor', addedAt = 1 }) {
  const path1 = `${groupKey}/01.mp3`;
  const path2 = `${groupKey}/02.mp3`;
  const file1 = seedAudio(db, {
    category: 'audiobooks', relPath: path1, groupKey, groupTitle: title, groupArtist: author,
    title: 'Teil 1', trackNo: 1, addedAt, durationMs: 180_000,
  });
  const file2 = seedAudio(db, {
    category: 'audiobooks', relPath: path2, groupKey, groupTitle: title, groupArtist: author,
    title: 'Teil 2', trackNo: 2, addedAt, durationMs: 180_000,
  });
  return { file1, file2, path1, path2 };
}

/**
 * A compact sort key for asserting item order: `'music'`, or the
 * audiobook's own id.
 * @param {{ kind: string, id?: number }} item
 * @returns {string}
 */
function kindId(item) {
  return item.kind === 'music' ? 'music' : `audiobook:${item.id}`;
}

/**
 * Seeds one music track with a progress row at `updatedAt`.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} userId
 * @param {number} updatedAt
 * @returns {number} the track's item id
 */
function seedMusicAt(db, userId, updatedAt) {
  const relPath = 'Musik/A/Album/01.mp3';
  const track = seedAudio(db, {
    category: 'music', relPath, groupKey: 'Musik/A/Album', groupTitle: 'Album', groupArtist: 'A',
    title: 'Titel', addedAt: 1, durationMs: 200_000,
  });
  seedProgress(db, { userId, relPath, position: 40, duration: 200, updatedAt });
  return track;
}

test('merge order: newest-first across music and audiobooks', async () => {
  const app = await startTestApp();
  try {
    const alice = await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');

    const track = seedMusicAt(app.db, alice.id, 2000);
    const bookA = seedBook(app.db, { groupKey: 'Hörbücher/A' });
    seedProgress(app.db, { userId: alice.id, relPath: bookA.path1, position: 60, duration: 180, updatedAt: 3000 });
    const bookB = seedBook(app.db, { groupKey: 'Hörbücher/B' });
    seedProgress(app.db, { userId: alice.id, relPath: bookB.path1, position: 60, duration: 180, updatedAt: 1000 });

    const { body } = await get(app.baseUrl, '/api/home/listening', cookie);
    assert.deepEqual(body.items.map(kindId), [`audiobook:${bookA.file1}`, 'music', `audiobook:${bookB.file1}`]);
    assert.ok(track);
  } finally {
    await app.close();
  }
});

test('ties: music before an audiobook at the same instant; two audiobooks tie-break by ascending id', async () => {
  const app = await startTestApp();
  try {
    const alice = await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');

    seedMusicAt(app.db, alice.id, 5000);
    const bookA = seedBook(app.db, { groupKey: 'Hörbücher/Erstes' });
    seedProgress(app.db, { userId: alice.id, relPath: bookA.path1, position: 60, duration: 180, updatedAt: 5000 });
    const bookB = seedBook(app.db, { groupKey: 'Hörbücher/Zweites' });
    seedProgress(app.db, { userId: alice.id, relPath: bookB.path1, position: 60, duration: 180, updatedAt: 5000 });
    assert.ok(bookB.file1 > bookA.file1, 'book B must have the higher id for this test to be meaningful');

    const { body } = await get(app.baseUrl, '/api/home/listening', cookie);
    assert.deepEqual(body.items.map(kindId), ['music', `audiobook:${bookA.file1}`, `audiobook:${bookB.file1}`]);
  } finally {
    await app.close();
  }
});

test('limit caps the merged, newest-first list', async () => {
  const app = await startTestApp();
  try {
    const alice = await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');

    const track = seedMusicAt(app.db, alice.id, 4000);
    const bookA = seedBook(app.db, { groupKey: 'Hörbücher/A' });
    seedProgress(app.db, { userId: alice.id, relPath: bookA.path1, position: 60, duration: 180, updatedAt: 3000 });
    const bookB = seedBook(app.db, { groupKey: 'Hörbücher/B' });
    seedProgress(app.db, { userId: alice.id, relPath: bookB.path1, position: 60, duration: 180, updatedAt: 2000 });
    const bookC = seedBook(app.db, { groupKey: 'Hörbücher/C' });
    seedProgress(app.db, { userId: alice.id, relPath: bookC.path1, position: 60, duration: 180, updatedAt: 1000 });

    const { body } = await get(app.baseUrl, '/api/home/listening?limit=2', cookie);
    assert.deepEqual(body.items.map(kindId), ['music', `audiobook:${bookA.file1}`]);
    assert.equal(body.items[0].trackId, track);
    assert.ok(bookB.file1 && bookC.file1);
  } finally {
    await app.close();
  }
});
