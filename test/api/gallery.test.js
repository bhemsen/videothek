import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from '../helpers/app.js';
import { get, idOf, seedItem, seedItemWithMeta } from './gallery-test-helpers.js';

test('unauthenticated GET /api/gallery answers 401 {"error":"unauthorized"}', async () => {
  const app = await startTestApp();
  try {
    const res = await get(app.baseUrl, '/api/gallery');
    assert.equal(res.status, 401);
    assert.deepEqual(res.body, { error: 'unauthorized' });
  } finally {
    await app.close();
  }
});

test('root of an empty library answers 200 with an empty view', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('julia', 'ein-sicheres-passwort');
    const cookie = await app.login('julia', 'ein-sicheres-passwort');
    const res = await get(app.baseUrl, '/api/gallery', { Cookie: cookie });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { key: '', name: '', breadcrumb: [], folders: [], items: [] });
  } finally {
    await app.close();
  }
});

test('shape, breadcrumb, direct-children items only and aggregated subtree folder counts', async (t) => {
  const app = await startTestApp();
  try {
    await app.createUser('julia', 'ein-sicheres-passwort');
    const cookie = await app.login('julia', 'ein-sicheres-passwort');
    const { db } = app;

    // A root-level file directly in "Urlaub" plus a nested subfolder "Italien"
    // holding a playable image, a video and a non-playable image.
    seedItem(db, 'Urlaub', { rel_path: 'Bilder/Urlaub/root.jpg' });
    seedItem(db, 'Urlaub/Italien', { rel_path: 'Bilder/Urlaub/Italien/a.jpg' });
    seedItem(db, 'Urlaub/Italien', {
      rel_path: 'Bilder/Urlaub/Italien/clip.mp4',
      kind: 'video',
      ext: 'mp4',
    });
    seedItem(db, 'Urlaub/Italien', {
      rel_path: 'Bilder/Urlaub/Italien/photo.heic',
      ext: 'heic',
      playable: 0,
    });

    await t.test('root lists "Urlaub" with the whole subtree count (4)', async () => {
      const res = await get(app.baseUrl, '/api/gallery', { Cookie: cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.key, '');
      assert.deepEqual(res.body.breadcrumb, []);
      assert.equal(res.body.items.length, 0);
      assert.equal(res.body.folders.length, 1);
      assert.deepEqual(
        { key: res.body.folders[0].key, name: res.body.folders[0].name, count: res.body.folders[0].count },
        { key: 'Urlaub', name: 'Urlaub', count: 4 },
      );
    });

    await t.test('"Urlaub" shows its direct item plus the "Italien" child with the subtree count (3)', async () => {
      const res = await get(app.baseUrl, `/api/gallery?folder=${encodeURIComponent('Urlaub')}`, { Cookie: cookie });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'Urlaub');
      assert.deepEqual(res.body.breadcrumb, []);
      assert.equal(res.body.items.length, 1);
      assert.equal(res.body.items[0].name, 'root.jpg');
      assert.deepEqual(
        { key: res.body.folders[0].key, name: res.body.folders[0].name, count: res.body.folders[0].count },
        { key: 'Urlaub/Italien', name: 'Italien', count: 3 },
      );
    });

    await t.test('"Urlaub/Italien" lists all 3 direct items (incl. video and non-playable) and a breadcrumb', async () => {
      const res = await get(app.baseUrl, `/api/gallery?folder=${encodeURIComponent('Urlaub/Italien')}`, {
        Cookie: cookie,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.name, 'Italien');
      assert.deepEqual(res.body.breadcrumb, [{ key: 'Urlaub', name: 'Urlaub' }]);
      assert.equal(res.body.items.length, 3);
      assert.deepEqual(res.body.folders, []);
    });
  } finally {
    await app.close();
  }
});

test('response shape carries exactly the spec keys — no relPath/dir/thumb/version', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('julia', 'ein-sicheres-passwort');
    const cookie = await app.login('julia', 'ein-sicheres-passwort');
    const { db } = app;
    seedItemWithMeta(
      db,
      'Familie',
      { rel_path: 'Bilder/Familie/a.jpg', size: 1000, mtime_ms: 1_700_000_000_000 },
      { thumbOffset: 20, thumbLength: 30, sourceSize: 1000, sourceMtimeMs: 1_700_000_000_000, orientation: 6 },
    );

    const root = await get(app.baseUrl, '/api/gallery', { Cookie: cookie });
    assert.deepEqual(Object.keys(root.body).sort(), ['breadcrumb', 'folders', 'items', 'key', 'name'].sort());
    assert.equal(root.body.folders.length, 1);
    assert.deepEqual(Object.keys(root.body.folders[0]).sort(), ['cover', 'count', 'key', 'name'].sort());
    assert.deepEqual(Object.keys(root.body.folders[0].cover).sort(), ['thumbOrientation', 'thumbUrl'].sort());

    const folder = await get(app.baseUrl, `/api/gallery?folder=${encodeURIComponent('Familie')}`, {
      Cookie: cookie,
    });
    assert.equal(folder.body.items.length, 1);
    assert.deepEqual(
      Object.keys(folder.body.items[0]).sort(),
      ['id', 'name', 'kind', 'playable', 'takenAt', 'url', 'thumbUrl', 'thumbOrientation'].sort(),
    );
  } finally {
    await app.close();
  }
});

test('cover choice: first playable image in (folder, rel_path) order; video/non-playable never chosen', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('julia', 'ein-sicheres-passwort');
    const cookie = await app.login('julia', 'ein-sicheres-passwort');
    const { db } = app;

    // Inserted out of rel_path order on purpose.
    seedItem(db, 'Album', { rel_path: 'Bilder/Album/z-second.jpg' });
    seedItem(db, 'Album', { rel_path: 'Bilder/Album/a-non-playable.jpg', ext: 'heic', playable: 0 });
    seedItem(db, 'Album', { rel_path: 'Bilder/Album/a-video.mp4', kind: 'video', ext: 'mp4' });
    seedItem(db, 'Album', { rel_path: 'Bilder/Album/b-first.jpg' });

    const res = await get(app.baseUrl, '/api/gallery', { Cookie: cookie });
    const albumFolder = res.body.folders.find((/** @type {any} */ f) => f.key === 'Album');
    assert.ok(albumFolder, 'expected an "Album" folder tile');
    assert.ok(albumFolder.cover, 'expected a cover (a playable image exists)');
    assert.equal(albumFolder.cover.thumbUrl, `/media/${idOf(db, 'Bilder/Album/b-first.jpg')}`);
  } finally {
    await app.close();
  }
});

test('alias merge: two aliased category roots stub into the same folder key and aggregate together', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('julia', 'ein-sicheres-passwort');
    const cookie = await app.login('julia', 'ein-sicheres-passwort');
    const { db } = app;
    seedItem(db, 'Familie', { rel_path: 'Bilder/Familie/a.jpg', dir: 'Bilder/Familie' });
    seedItem(db, 'Familie', { rel_path: 'Photos/Familie/b.jpg', dir: 'Photos/Familie' });

    const res = await get(app.baseUrl, '/api/gallery', { Cookie: cookie });
    assert.equal(res.body.folders.length, 1);
    assert.deepEqual(
      { key: res.body.folders[0].key, count: res.body.folders[0].count },
      { key: 'Familie', count: 2 },
    );
  } finally {
    await app.close();
  }
});

test('sort order: items ordered by takenAt (EXIF or mtime fallback), oldest first', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('julia', 'ein-sicheres-passwort');
    const cookie = await app.login('julia', 'ein-sicheres-passwort');
    const { db } = app;
    seedItem(db, 'Sort', { rel_path: 'Bilder/Sort/newer.jpg', mtime_ms: 2_000_000_000_000 });
    seedItem(db, 'Sort', { rel_path: 'Bilder/Sort/older.jpg', mtime_ms: 1_000_000_000_000 });

    const res = await get(app.baseUrl, `/api/gallery?folder=${encodeURIComponent('Sort')}`, { Cookie: cookie });
    assert.deepEqual(
      res.body.items.map((/** @type {any} */ i) => i.name),
      ['older.jpg', 'newer.jpg'],
    );
  } finally {
    await app.close();
  }
});

test('URL mapping: embedded thumb, original fallback, video and non-playable', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('julia', 'ein-sicheres-passwort');
    const cookie = await app.login('julia', 'ein-sicheres-passwort');
    const { db } = app;

    const embeddedId = seedItemWithMeta(
      db,
      'Mix',
      { rel_path: 'Bilder/Mix/a-embedded.jpg', size: 1000, mtime_ms: 1_700_000_000_000 },
      { thumbOffset: 20, thumbLength: 30, sourceSize: 1000, sourceMtimeMs: 1_700_000_000_000, orientation: 6 },
    );
    const originalId = seedItem(db, 'Mix', { rel_path: 'Bilder/Mix/b-original.jpg', mtime_ms: 1_600_000_000_000 });
    const videoId = seedItem(db, 'Mix', {
      rel_path: 'Bilder/Mix/c-video.mp4',
      kind: 'video',
      ext: 'mp4',
      mtime_ms: 1_650_000_000_000,
    });
    const nonPlayableId = seedItem(db, 'Mix', {
      rel_path: 'Bilder/Mix/d-heic.heic',
      ext: 'heic',
      playable: 0,
      mtime_ms: 1_680_000_000_000,
    });

    const res = await get(app.baseUrl, `/api/gallery?folder=${encodeURIComponent('Mix')}`, { Cookie: cookie });
    const byId = /** @type {Record<number, any>} */ (
      Object.fromEntries(res.body.items.map((/** @type {any} */ i) => [i.id, i]))
    );

    assert.equal(byId[embeddedId].thumbUrl, `/media/${embeddedId}/thumb?v=1700000000000`);
    assert.equal(byId[embeddedId].url, `/media/${embeddedId}`);
    assert.equal(byId[embeddedId].thumbOrientation, 6);

    assert.equal(byId[originalId].thumbUrl, `/media/${originalId}`);
    assert.equal(byId[originalId].url, `/media/${originalId}`);
    assert.equal(byId[originalId].thumbOrientation, 1);

    assert.equal(byId[videoId].thumbUrl, null);
    assert.equal(byId[videoId].url, `/media/${videoId}`, 'a playable video still gets a stream url');
    assert.equal(byId[videoId].kind, 'video');

    assert.equal(byId[nonPlayableId].thumbUrl, null);
    assert.equal(byId[nonPlayableId].url, null);
    assert.equal(byId[nonPlayableId].playable, false);
  } finally {
    await app.close();
  }
});

test('a folder key containing "\\" of an existing folder answers 200', async () => {
  const app = await startTestApp();
  try {
    await app.createUser('julia', 'ein-sicheres-passwort');
    const cookie = await app.login('julia', 'ein-sicheres-passwort');
    const { db } = app;
    seedItem(db, 'A\\B', { rel_path: 'Bilder/A/B/item.jpg' });

    const res = await get(app.baseUrl, `/api/gallery?folder=${encodeURIComponent('A\\B')}`, { Cookie: cookie });
    assert.equal(res.status, 200);
    assert.equal(res.body.items.length, 1);
  } finally {
    await app.close();
  }
});
