// @ts-check

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { open as fsOpen } from 'node:fs/promises';
import path from 'node:path';
import { insertMetaStubs, saveMeta } from '../../src/db/image-meta.js';
import { parseExif } from '../../src/library/tags/exif.js';
import { buildExifJpeg } from '../helpers/exif-jpeg.js';
import { insertItem } from '../helpers/image-meta-seed.js';
import { startTestApp } from '../helpers/app.js';

/**
 * A test seam wrapping every opened handle so a test can assert it was
 * closed, tracking each open individually (unlike one shared boolean) so a
 * multi-open request (the pre-check open plus `sendMedia`'s own) cannot hide
 * one unclosed handle behind another one that did close.
 * @returns {{ openFile: (p: string) => Promise<import('node:fs/promises').FileHandle>, opened: () => number, allClosed: () => boolean }}
 */
function trackOpens() {
  /** @type {boolean[]} */
  const closedFlags = [];
  return {
    openFile: async (p) => {
      const handle = await fsOpen(p, 'r');
      const index = closedFlags.push(false) - 1;
      return new Proxy(handle, {
        get(target, prop, receiver) {
          if (prop === 'close') {
            return async () => {
              closedFlags[index] = true;
              return target.close();
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    },
    opened: () => closedFlags.length,
    allClosed: () => closedFlags.every(Boolean),
  };
}

/**
 * Writes a fresh EXIF JPEG with a valid embedded thumbnail under `mediaRoot`
 * at `relPath` and returns everything a seeded `image_meta` row needs.
 * @param {string} mediaRoot @param {string} relPath
 */
async function writeThumbFixture(mediaRoot, relPath) {
  const buf = buildExifJpeg({ orientation: 1, thumbnail: { compression: 6 } });
  const full = path.join(mediaRoot, relPath);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, buf);
  const fileStat = await stat(full);
  const { thumbOffset, thumbLength } = parseExif(buf);
  if (thumbOffset === null || thumbLength === null) throw new Error('fixture built with no thumbnail');
  return {
    thumbOffset,
    thumbLength,
    size: fileStat.size,
    mtimeMs: Math.trunc(fileStat.mtimeMs),
    thumbBytes: buf.subarray(thumbOffset, thumbOffset + thumbLength),
  };
}

/**
 * Inserts one `library_items` row plus, unless `meta` is `null`, an
 * `image_meta` row (stub, then header fields when `meta` is given).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Partial<{ rel_path: string, dir: string, category: string, kind: string, ext: string, playable: number, size: number, mtime_ms: number }>} item
 * @param {{ thumbOffset: number | null, thumbLength: number | null, sourceSize?: number, sourceMtimeMs?: number } | null} [meta]
 * @returns {number}
 */
function seedItem(db, item, meta) {
  const itemId = insertItem(db, item);
  if (meta === null) return itemId;
  insertMetaStubs(db, [{ itemId, folder: '' }]);
  if (meta !== undefined) {
    saveMeta(db, itemId, {
      takenAt: null,
      orientation: null,
      thumbOffset: meta.thumbOffset,
      thumbLength: meta.thumbLength,
      sourceSize: meta.sourceSize ?? 0,
      sourceMtimeMs: meta.sourceMtimeMs ?? 0,
      metaVersion: 1,
    });
  }
  return itemId;
}

/**
 * Boots the app, logs a user in and seeds one valid image item with a real,
 * verifiable thumbnail on disk.
 * @param {{ openFile?: (p: string) => Promise<import('node:fs/promises').FileHandle> }} [extra]
 */
async function setup(extra = {}) {
  const app = await startTestApp({ ...extra });
  await app.createUser('alice', 'password123');
  const cookie = await app.login('alice', 'password123');
  const fixture = await writeThumbFixture(app.config.mediaRoot, 'Bilder/photo.jpg');
  const itemId = seedItem(
    app.db,
    { rel_path: 'Bilder/photo.jpg', dir: 'Bilder', size: fixture.size, mtime_ms: fixture.mtimeMs },
    { thumbOffset: fixture.thumbOffset, thumbLength: fixture.thumbLength, sourceSize: fixture.size, sourceMtimeMs: fixture.mtimeMs }
  );
  return { app, cookie, itemId, fixture };
}

/** @param {Awaited<ReturnType<typeof setup>>['app']} app @param {string} cookie @param {number|string} id */
function getThumb(app, cookie, id, headers = {}) {
  return fetch(`${app.baseUrl}/media/${id}/thumb`, { headers: { Cookie: cookie, ...headers } });
}

test('GET /media/:id/thumb: 200 with the exact thumbnail bytes and the immutable/nosniff headers', async () => {
  const { app, cookie, itemId, fixture } = await setup();
  try {
    const res = await getThumb(app, cookie, itemId);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('content-length'), String(fixture.thumbLength));
    assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), fixture.thumbBytes);
  } finally {
    await app.close();
  }
});

test('GET /media/:id/thumb: a trailing ?v= is ignored; HEAD has no body; Range 0-1 answers 206', async () => {
  const { app, cookie, itemId, fixture } = await setup();
  try {
    const withV = await fetch(`${app.baseUrl}/media/${itemId}/thumb?v=123`, { headers: { Cookie: cookie } });
    assert.equal(withV.status, 200);
    assert.deepEqual(Buffer.from(await withV.arrayBuffer()), fixture.thumbBytes);

    const head = await fetch(`${app.baseUrl}/media/${itemId}/thumb`, { method: 'HEAD', headers: { Cookie: cookie } });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(fixture.thumbLength));
    assert.equal(Buffer.from(await head.arrayBuffer()).length, 0);

    const ranged = await getThumb(app, cookie, itemId, { Range: 'bytes=0-1' });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 0-1/${fixture.thumbLength}`);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), fixture.thumbBytes.subarray(0, 2));
  } finally {
    await app.close();
  }
});

test('GET /media/:id/thumb: unauthenticated answers 401 JSON', async () => {
  const { app, itemId } = await setup();
  try {
    const res = await fetch(`${app.baseUrl}/media/${itemId}/thumb`);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  } finally {
    await app.close();
  }
});

test('GET /media/:id/thumb: 404 for every malformed/unknown id and every failing pre-check', async () => {
  const { app, cookie, itemId } = await setup();
  try {
    for (const bad of ['abc', '0', '01', '12345678901234567', '9999999999999999']) {
      assert.equal((await getThumb(app, cookie, bad)).status, 404, `id "${bad}"`);
    }
    assert.equal((await getThumb(app, cookie, itemId + 1000)).status, 404, 'unknown id');

    /** @type {Record<string, () => Promise<number>>} */
    const scenarios = {
      'non-image item (other category)': async () =>
        insertItem(app.db, { rel_path: 'Filme/movie.mp4', dir: 'Filme', category: 'movies', kind: 'video', ext: 'mp4' }),
      'video item under images': async () => {
        const f = await writeThumbFixture(app.config.mediaRoot, 'Bilder/clip.mp4');
        return seedItem(
          app.db,
          { rel_path: 'Bilder/clip.mp4', dir: 'Bilder', kind: 'video', ext: 'mp4', size: f.size, mtime_ms: f.mtimeMs },
          { thumbOffset: f.thumbOffset, thumbLength: f.thumbLength, sourceSize: f.size, sourceMtimeMs: f.mtimeMs }
        );
      },
      'non-playable image': async () => {
        const f = await writeThumbFixture(app.config.mediaRoot, 'Bilder/heic-like.jpg');
        return seedItem(
          app.db,
          { rel_path: 'Bilder/heic-like.jpg', dir: 'Bilder', playable: 0, size: f.size, mtime_ms: f.mtimeMs },
          { thumbOffset: f.thumbOffset, thumbLength: f.thumbLength, sourceSize: f.size, sourceMtimeMs: f.mtimeMs }
        );
      },
      'no thumbnail recorded yet (stub only)': async () => seedItem(app.db, { rel_path: 'Bilder/unsynced.jpg', dir: 'Bilder' }),
      'changed size/mtime since the header was read': async () => {
        const f = await writeThumbFixture(app.config.mediaRoot, 'Bilder/stale.jpg');
        return seedItem(
          app.db,
          { rel_path: 'Bilder/stale.jpg', dir: 'Bilder', size: f.size, mtime_ms: f.mtimeMs },
          { thumbOffset: f.thumbOffset, thumbLength: f.thumbLength, sourceSize: f.size + 1, sourceMtimeMs: f.mtimeMs }
        );
      },
      'recorded offset no longer starts FF D8': async () => {
        // Offset 2 is the APP1 marker (FF E1), not a JPEG SOI (FF D8) — deterministically "not FF D8".
        const f = await writeThumbFixture(app.config.mediaRoot, 'Bilder/corrupt.jpg');
        return seedItem(
          app.db,
          { rel_path: 'Bilder/corrupt.jpg', dir: 'Bilder', size: f.size, mtime_ms: f.mtimeMs },
          { thumbOffset: 2, thumbLength: f.thumbLength, sourceSize: f.size, sourceMtimeMs: f.mtimeMs }
        );
      },
      'rel_path escaping MEDIA_ROOT': async () =>
        seedItem(app.db, { rel_path: '../outside.jpg', dir: '..', size: 10, mtime_ms: 10 }, { thumbOffset: 0, thumbLength: 2, sourceSize: 10, sourceMtimeMs: 10 }),
    };
    for (const [label, seedScenario] of Object.entries(scenarios)) {
      const id = await seedScenario();
      assert.equal((await getThumb(app, cookie, id)).status, 404, label);
    }
  } finally {
    await app.close();
  }
});

test('every handle opened through the injected openFile spy is closed, on every path', async () => {
  const tracker = trackOpens();
  const { app, cookie, itemId } = await setup({ openFile: tracker.openFile });
  try {
    // Happy path: one open for verifyThumb's pre-check, one for sendMedia's own read.
    await getThumb(app, cookie, itemId);
    assert.equal(tracker.opened(), 2);
    assert.equal(tracker.allClosed(), true);

    // A pre-check failure before resolveMediaPath/verifyThumb ever runs opens nothing.
    await getThumb(app, cookie, 'unknown');
    assert.equal(tracker.opened(), 2);

    // A failed verifyThumb pre-check (stale header) opens and closes exactly one handle.
    const f = await writeThumbFixture(app.config.mediaRoot, 'Bilder/stale2.jpg');
    const staleId = seedItem(
      app.db,
      { rel_path: 'Bilder/stale2.jpg', dir: 'Bilder', size: f.size, mtime_ms: f.mtimeMs },
      { thumbOffset: f.thumbOffset, thumbLength: f.thumbLength, sourceSize: f.size + 5, sourceMtimeMs: f.mtimeMs }
    );
    await getThumb(app, cookie, staleId);
    assert.equal(tracker.opened(), 3);
    assert.equal(tracker.allClosed(), true);
  } finally {
    await app.close();
  }
});
