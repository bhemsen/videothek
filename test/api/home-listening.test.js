import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedAudio, seedProgress } from '../helpers/home-seed.js';
import { startTestApp } from '../helpers/app.js';

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
 * Seeds a two-file, 180s-per-file audiobook and returns both item ids and
 * rel paths, for progress rows to key off.
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

test('GET /api/home/listening requires a session', async () => {
  const app = await startTestApp();
  try {
    assert.deepEqual(await get(app.baseUrl, '/api/home/listening'), { status: 401, body: { error: 'unauthorized' } });
  } finally {
    await app.close();
  }
});

test('GET /api/home/listening validates limit: 400 outside 1..20, 200 at the bounds', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');
    for (const limit of ['0', '21', '-1', '1.5', 'abc', '']) {
      const { status, body } = await get(app.baseUrl, `/api/home/listening?limit=${limit}`, cookie);
      assert.equal(status, 400, `limit=${limit}`);
      assert.deepEqual(body, { error: 'invalid_query' });
    }
    for (const limit of ['1', '20']) {
      const { status } = await get(app.baseUrl, `/api/home/listening?limit=${limit}`, cookie);
      assert.equal(status, 200, `limit=${limit}`);
    }
  } finally {
    await app.close();
  }
});

test('GET /api/home/listening: no progress -> empty items, even with a library that has books', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');
    seedBook(app.db, { groupKey: 'Hörbücher/Ohne Fortschritt' });

    const { status, body } = await get(app.baseUrl, '/api/home/listening', cookie);
    assert.equal(status, 200);
    assert.deepEqual(body, { items: [] });
  } finally {
    await app.close();
  }
});

test('music card: an unfinished, playable, above-threshold track appears with the resolved album id/cover', async () => {
  const app = await startTestApp();
  try {
    const alice = await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');
    const track1 = seedAudio(app.db, {
      category: 'music', relPath: 'Musik/Die Beispiele/Unterwegs/01 Titel.mp3',
      groupKey: 'Musik/Die Beispiele/Unterwegs', groupTitle: 'Unterwegs', groupArtist: 'Die Beispiele',
      title: 'Titel 1', trackNo: 1, addedAt: 1, durationMs: 240_000,
    });
    const track2 = seedAudio(app.db, {
      category: 'music', relPath: 'Musik/Die Beispiele/Unterwegs/02 Titel.mp3',
      groupKey: 'Musik/Die Beispiele/Unterwegs', groupTitle: 'Unterwegs', groupArtist: 'Die Beispiele',
      title: 'Titel 2', trackNo: 2, addedAt: 1, durationMs: 240_000,
    });
    seedProgress(app.db, {
      userId: alice.id, relPath: 'Musik/Die Beispiele/Unterwegs/02 Titel.mp3',
      position: 95, duration: 240, updatedAt: 1_700_000_000_000,
    });

    const { status, body } = await get(app.baseUrl, '/api/home/listening', cookie);
    assert.equal(status, 200);
    assert.deepEqual(body.items, [{
      kind: 'music',
      trackId: track2,
      albumId: track1,
      title: 'Titel 2',
      artist: 'Die Beispiele',
      albumTitle: 'Unterwegs',
      coverId: track1,
      position: 95,
      duration: 240,
      updatedAt: new Date(1_700_000_000_000).toISOString(),
    }]);
  } finally {
    await app.close();
  }
});

test('music exclusions: below threshold, finished, non-playable or meta-less tracks never appear', async () => {
  const app = await startTestApp();
  try {
    const alice = await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');

    seedAudio(app.db, {
      category: 'music', relPath: 'Musik/A/Album/01.mp3', groupKey: 'Musik/A/Album',
      groupTitle: 'Album', groupArtist: 'A', title: 'Below', addedAt: 1, durationMs: 240_000,
    });
    seedProgress(app.db, { userId: alice.id, relPath: 'Musik/A/Album/01.mp3', position: 29, duration: 240, updatedAt: 1000 });

    seedAudio(app.db, {
      category: 'music', relPath: 'Musik/B/Album/01.mp3', groupKey: 'Musik/B/Album',
      groupTitle: 'Album', groupArtist: 'B', title: 'Finished', addedAt: 1, durationMs: 240_000,
    });
    seedProgress(app.db, {
      userId: alice.id, relPath: 'Musik/B/Album/01.mp3', position: 240, duration: 240, finished: true, updatedAt: 1000,
    });

    seedAudio(app.db, {
      category: 'music', relPath: 'Musik/C/Album/01.mp3', groupKey: 'Musik/C/Album',
      groupTitle: 'Album', groupArtist: 'C', title: 'Unplayable', addedAt: 1, durationMs: 240_000, playable: false,
    });
    seedProgress(app.db, { userId: alice.id, relPath: 'Musik/C/Album/01.mp3', position: 95, duration: 240, updatedAt: 1000 });

    seedAudio(app.db, {
      category: 'music', relPath: 'Musik/D/Album/01.mp3', groupKey: 'Musik/D/Album',
      groupTitle: 'Album', groupArtist: 'D', title: 'NoMeta', addedAt: 1, withMeta: false,
    });
    seedProgress(app.db, { userId: alice.id, relPath: 'Musik/D/Album/01.mp3', position: 95, duration: 240, updatedAt: 1000 });

    const { body } = await get(app.baseUrl, '/api/home/listening', cookie);
    assert.deepEqual(body.items, []);
  } finally {
    await app.close();
  }
});

test('music card: only the more recently updated of two unfinished tracks appears', async () => {
  const app = await startTestApp();
  try {
    const alice = await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');
    const older = seedAudio(app.db, {
      category: 'music', relPath: 'Musik/A/Album/01.mp3', groupKey: 'Musik/A/Album',
      groupTitle: 'Album', groupArtist: 'A', title: 'Alt', addedAt: 1, durationMs: 200_000,
    });
    seedProgress(app.db, { userId: alice.id, relPath: 'Musik/A/Album/01.mp3', position: 40, duration: 200, updatedAt: 1000 });
    const newer = seedAudio(app.db, {
      category: 'music', relPath: 'Musik/B/Album/01.mp3', groupKey: 'Musik/B/Album',
      groupTitle: 'Album', groupArtist: 'B', title: 'Neu', addedAt: 1, durationMs: 200_000,
    });
    seedProgress(app.db, { userId: alice.id, relPath: 'Musik/B/Album/01.mp3', position: 40, duration: 200, updatedAt: 2000 });

    const { body } = await get(app.baseUrl, '/api/home/listening', cookie);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0].trackId, newer);
    assert.ok(older);
  } finally {
    await app.close();
  }
});

test('audiobook resume: one item derived from deriveBookProgress, remaining over known durations', async () => {
  const app = await startTestApp();
  try {
    const alice = await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');
    const book = seedBook(app.db, {
      groupKey: 'Hörbücher/Jules Beispiel/Die Reise', title: 'Die Reise', author: 'Jules Beispiel',
    });
    seedProgress(app.db, { userId: alice.id, relPath: book.path1, position: 60, duration: 180, updatedAt: 1_700_000_000_000 });

    const { status, body } = await get(app.baseUrl, '/api/home/listening', cookie);
    assert.equal(status, 200);
    assert.deepEqual(body.items, [{
      kind: 'audiobook',
      id: book.file1,
      title: 'Die Reise',
      author: 'Jules Beispiel',
      coverId: book.file1,
      fraction: 60 / 360,
      remaining: 300,
      updatedAt: new Date(1_700_000_000_000).toISOString(),
      resume: { itemId: book.file1, position: 60, fileTitle: 'Teil 1' },
    }]);
  } finally {
    await app.close();
  }
});

test('audiobook resume advances to the next unfinished file once the latest counted one is finished', async () => {
  const app = await startTestApp();
  try {
    const alice = await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');
    const book = seedBook(app.db, { groupKey: 'Hörbücher/Weiter' });
    seedProgress(app.db, { userId: alice.id, relPath: book.path1, position: 180, duration: 180, finished: true, updatedAt: 1000 });

    const { body } = await get(app.baseUrl, '/api/home/listening', cookie);
    assert.equal(body.items.length, 1);
    assert.deepEqual(body.items[0].resume, { itemId: book.file2, position: 0, fileTitle: 'Teil 2' });
    assert.equal(body.items[0].fraction, 0.5);
    assert.equal(body.items[0].remaining, 180);
  } finally {
    await app.close();
  }
});

test('audiobook exclusions: an all-finished book and a not-yet-started book are not listed', async () => {
  const app = await startTestApp();
  try {
    const alice = await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');

    const finished = seedBook(app.db, { groupKey: 'Hörbücher/Fertig' });
    seedProgress(app.db, { userId: alice.id, relPath: finished.path1, position: 180, duration: 180, finished: true, updatedAt: 1000 });
    seedProgress(app.db, { userId: alice.id, relPath: finished.path2, position: 180, duration: 180, finished: true, updatedAt: 1000 });

    const fresh = seedBook(app.db, { groupKey: 'Hörbücher/Kaum Begonnen' });
    seedProgress(app.db, { userId: alice.id, relPath: fresh.path1, position: 20, duration: 180, updatedAt: 1000 });

    const { body } = await get(app.baseUrl, '/api/home/listening', cookie);
    assert.deepEqual(body.items, []);
  } finally {
    await app.close();
  }
});

test('user isolation: Bob never sees Alice\'s listening items', async () => {
  const app = await startTestApp();
  try {
    const alice = await app.createUser('alice', 'password123');
    await app.createUser('bob', 'password456');
    const bobCookie = await app.login('bob', 'password456');
    const book = seedBook(app.db, { groupKey: 'Hörbücher/Alice Only' });
    seedProgress(app.db, { userId: alice.id, relPath: book.path1, position: 60, duration: 180, updatedAt: 1000 });

    const { body } = await get(app.baseUrl, '/api/home/listening', bobCookie);
    assert.deepEqual(body.items, []);
  } finally {
    await app.close();
  }
});
