import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveMeta } from '../../src/db/image-meta.js';
import { listRecentMovies, listRecentSeries } from '../../src/db/home-queries.js';
import { toItemJson } from '../../src/api/library-json.js';
import { toSeriesSummaryJson } from '../../src/api/library.js';
import { seedAudio, seedEpisode, seedImage, seedMovie } from '../helpers/home-seed.js';
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

test('GET /api/home/previews requires a session', async () => {
  const app = await startTestApp();
  try {
    assert.deepEqual(await get(app.baseUrl, '/api/home/previews'), { status: 401, body: { error: 'unauthorized' } });
  } finally {
    await app.close();
  }
});

test('GET /api/home/previews validates limit: 400 outside 1..20, 200 at the bounds', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');
    for (const limit of ['0', '21', '-1', '1.5', 'abc', '']) {
      const { status, body } = await get(app.baseUrl, `/api/home/previews?limit=${limit}`, cookie);
      assert.equal(status, 400, `limit=${limit}`);
      assert.deepEqual(body, { error: 'invalid_query' });
    }
    for (const limit of ['1', '20']) {
      const { status } = await get(app.baseUrl, `/api/home/previews?limit=${limit}`, cookie);
      assert.equal(status, 200, `limit=${limit}`);
    }
  } finally {
    await app.close();
  }
});

test('GET /api/home/previews: empty library -> every category empty', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');
    const { status, body } = await get(app.baseUrl, '/api/home/previews', cookie);
    assert.equal(status, 200);
    assert.deepEqual(body, {
      movies: { count: 0, items: [] },
      series: { count: 0, items: [] },
      music: { count: 0, items: [] },
      audiobooks: { count: 0, items: [] },
      images: { count: 0, items: [] },
    });
  } finally {
    await app.close();
  }
});

test('shapes: movies/series reuse the exact library serializers; music/audiobooks/images carry the documented keys', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');

    seedMovie(app.db, { relPath: 'Filme/Film.mp4', title: 'Film', addedAt: 1 });
    seedEpisode(app.db, { seriesKey: 'Serie', seriesTitle: 'Serie', relPath: 'Serien/Serie/S1E1.mp4', addedAt: 1 });
    seedAudio(app.db, {
      category: 'music', relPath: 'Musik/A/Album/01.mp3', groupKey: 'Musik/A/Album',
      groupTitle: 'Album', groupArtist: 'A', title: 'Titel', addedAt: 1,
    });
    seedAudio(app.db, {
      category: 'audiobooks', relPath: 'Hörbücher/Buch/01.mp3', groupKey: 'Hörbücher/Buch',
      groupTitle: 'Buch', groupArtist: 'Autor', title: 'Teil 1', addedAt: 1,
    });
    seedImage(app.db, { relPath: 'Bilder/A/x.jpg', folder: 'A', addedAt: 1 });

    const { body } = await get(app.baseUrl, '/api/home/previews', cookie);

    const [movieRow] = listRecentMovies(app.db, 1);
    assert.deepEqual(body.movies.items[0], toItemJson(movieRow));
    const [seriesRow] = listRecentSeries(app.db, 1);
    assert.deepEqual(body.series.items[0], toSeriesSummaryJson(seriesRow));
    assert.deepEqual(
      Object.keys(body.music.items[0]).sort(),
      ['id', 'title', 'artist', 'year', 'coverId', 'trackCount'].sort()
    );
    assert.deepEqual(
      Object.keys(body.audiobooks.items[0]).sort(),
      ['id', 'title', 'author', 'coverId', 'fileCount', 'duration'].sort()
    );
    assert.deepEqual(Object.keys(body.images.items[0]).sort(), ['key', 'name', 'count', 'cover'].sort());
  } finally {
    await app.close();
  }
});

test('limit caps items per category to 2 while counts stay at 3', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');

    for (let i = 1; i <= 3; i += 1) {
      seedMovie(app.db, { relPath: `Filme/M${i}.mp4`, title: `Film ${i}`, addedAt: i });
      seedEpisode(app.db, { seriesKey: `S${i}`, seriesTitle: `Serie ${i}`, relPath: `Serien/S${i}/S1E1.mp4`, addedAt: i });
      seedAudio(app.db, {
        category: 'music', relPath: `Musik/A${i}/Album/01.mp3`, groupKey: `Musik/A${i}/Album`,
        groupTitle: 'Album', groupArtist: `A${i}`, title: 'Titel', addedAt: i,
      });
      seedAudio(app.db, {
        category: 'audiobooks', relPath: `Hörbücher/B${i}/01.mp3`, groupKey: `Hörbücher/B${i}`,
        groupTitle: `Buch ${i}`, groupArtist: 'Autor', title: 'Teil 1', addedAt: i,
      });
      seedImage(app.db, { relPath: `Bilder/F${i}/x.jpg`, folder: `F${i}`, addedAt: i });
    }

    const { body } = await get(app.baseUrl, '/api/home/previews?limit=2', cookie);
    for (const key of ['movies', 'series', 'music', 'audiobooks', 'images']) {
      assert.equal(body[key].count, 3, key);
      assert.equal(body[key].items.length, 2, key);
    }
  } finally {
    await app.close();
  }
});

test('a non-playable movie is listed with playable:false; a series with only unplayable episodes has playableCount:0', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');

    seedMovie(app.db, { relPath: 'Filme/Kaputt.mp4', title: 'Kaputt', addedAt: 1, playable: false });
    seedEpisode(app.db, {
      seriesKey: 'Serie', seriesTitle: 'Serie', relPath: 'Serien/Serie/S1E1.mp4', addedAt: 1, playable: false,
    });

    const { body } = await get(app.baseUrl, '/api/home/previews', cookie);
    assert.equal(body.movies.items[0].playable, false);
    assert.equal(body.series.items[0].playableCount, 0);
  } finally {
    await app.close();
  }
});

test('album id/cover resolve by play order, not insertion order', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');

    // Track 2 inserted first (so it would get the lower id), track 1 second.
    seedAudio(app.db, {
      category: 'music', relPath: 'Musik/A/Album/02 Titel.mp3', groupKey: 'Musik/A/Album',
      groupTitle: 'Album', groupArtist: 'A', title: 'Zwei', trackNo: 2, addedAt: 1,
    });
    const track1 = seedAudio(app.db, {
      category: 'music', relPath: 'Musik/A/Album/01 Titel.mp3', groupKey: 'Musik/A/Album',
      groupTitle: 'Album', groupArtist: 'A', title: 'Eins', trackNo: 1, addedAt: 2,
    });

    const { body } = await get(app.baseUrl, '/api/home/previews', cookie);
    assert.equal(body.music.items[0].id, track1);
    assert.equal(body.music.items[0].coverId, track1);
    assert.equal(body.music.items[0].trackCount, 2);
  } finally {
    await app.close();
  }
});

test('images: subtree counts, a root-level file raises count without a tile, and cover thumbnails', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('alice', 'password123');
    const cookie = await app.login('alice', 'password123');

    const coverId = seedImage(app.db, { relPath: 'Bilder/A/x.jpg', folder: 'A', addedAt: 3 });
    seedImage(app.db, { relPath: 'Bilder/A/B/y.jpg', folder: 'A/B', addedAt: 2 });
    seedImage(app.db, { relPath: 'Bilder/C/z.jpg', folder: 'C', addedAt: 1 });
    seedImage(app.db, { relPath: 'Bilder/r.jpg', folder: '', addedAt: 4 });

    const before = await get(app.baseUrl, '/api/home/previews', cookie);
    assert.equal(before.body.images.count, 4, 'root-level file counted but tile-less');
    assert.equal(before.body.images.items.length, 2, 'only A and C get a tile, root excluded');
    const folderA = before.body.images.items.find((/** @type {any} */ f) => f.key === 'A');
    assert.equal(folderA.count, 2, 'A aggregates its own file plus A/B');
    assert.equal(folderA.cover.thumbUrl, `/media/${coverId}`, 'no embedded thumb yet -> original');

    saveMeta(app.db, coverId, {
      takenAt: null, orientation: null, thumbOffset: 2, thumbLength: 10,
      sourceSize: 1000, sourceMtimeMs: 1_700_000_000_000, metaVersion: 1,
    });
    const after = await get(app.baseUrl, '/api/home/previews', cookie);
    const folderAAfter = after.body.images.items.find((/** @type {any} */ f) => f.key === 'A');
    assert.equal(folderAAfter.cover.thumbUrl, `/media/${coverId}/thumb?v=1700000000000`);
  } finally {
    await app.close();
  }
});
