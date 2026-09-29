// @ts-check

/**
 * `GET /media/:id` serving a fresh converted copy from `CONVERT_DIR`
 * (docs/specs/spec-conversion-core.md, "Serving"). Complements
 * `test/api/media.test.js` (the unconverted-item route), which stays
 * unchanged. Path-related cases (containment, `CONVERT_DIR` not read,
 * subtitle sidecars) live in `media-converted-paths.test.js`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { upsertItem } from '../../src/db/library-repo.js';
import {
  getMedia,
  makeItem,
  patternBytes,
  seedConvertedItem,
  setup,
  SOURCE_MTIME,
  SOURCE_REL,
  SOURCE_SIZE,
  STORAGE_KEY,
} from './media-converted-helpers.js';

test('GET /media/:id: a converted item streams the fresh copy, not the source, with the copy\'s own MIME type', async () => {
  const { app, cookie } = await setup();
  try {
    const sourceBytes = patternBytes(50, 0);
    const outputBytes = patternBytes(30, 99);
    const outputRel = `${STORAGE_KEY}/web.mp4`;
    const id = await seedConvertedItem(app, { sourceBytes, outputRel, outputBytes });

    const full = await getMedia(app, cookie, id);
    assert.equal(full.status, 200);
    assert.equal(full.headers.get('content-type'), 'video/mp4');
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), outputBytes, 'streams the copy, not the source');

    const ranged = await getMedia(app, cookie, id, { headers: { Range: 'bytes=5-9' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-range'), `bytes 5-9/${outputBytes.length}`);
    assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), outputBytes.subarray(5, 10));

    const beyond = `bytes=${outputBytes.length + 10}-${outputBytes.length + 20}`;
    const unsatisfiable = await getMedia(app, cookie, id, { headers: { Range: beyond } });
    assert.equal(unsatisfiable.status, 416);
    assert.equal(unsatisfiable.headers.get('content-range'), `bytes */${outputBytes.length}`);

    // fetch never exposes a HEAD body, so the copy's own headers (length and
    // MIME type, both different from the source's) carry this check.
    const head = await getMedia(app, cookie, id, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), String(outputBytes.length));
    assert.equal(head.headers.get('content-type'), 'video/mp4');

    const sourceOnDisk = await readFile(path.join(app.config.mediaRoot, SOURCE_REL));
    assert.deepEqual(sourceOnDisk, sourceBytes, 'the original under MEDIA_ROOT is byte-identical afterwards');
  } finally {
    await app.close();
  }
});

test('GET /media/:id: audio copies stream with the MIME type of their own extension (flac, opus)', async () => {
  const { app, cookie } = await setup();
  try {
    const cases = /** @type {const} */ ([
      { target: 'flac', file: 'audio.flac', mime: 'audio/flac', key: 'b' },
      { target: 'opus', file: 'audio.opus', mime: 'audio/ogg', key: 'c' },
    ]);
    for (const { target, file, mime, key } of cases) {
      const relPath = `Musik/Artist/Album/Song ${target}.wma`;
      const outputBytes = patternBytes(25, key.charCodeAt(0));
      const storageKey = key.repeat(64);
      const id = await seedConvertedItem(app, {
        sourceBytes: patternBytes(40, 0),
        outputRel: `${storageKey}/${file}`,
        outputBytes,
        storageKey,
        target,
        item: { rel_path: relPath, dir: 'Musik/Artist/Album', category: 'music', kind: 'audio', ext: 'wma', title: relPath, sort_title: relPath },
      });

      const res = await getMedia(app, cookie, id);
      assert.equal(res.status, 200, file);
      assert.equal(res.headers.get('content-type'), mime, file);
      assert.deepEqual(Buffer.from(await res.arrayBuffer()), outputBytes, file);
    }
  } finally {
    await app.close();
  }
});

test('GET /media/:id: a stale copy (source changed since conversion) answers 404 not_playable', async () => {
  const { app, cookie } = await setup();
  try {
    const id = await seedConvertedItem(app, {
      sourceBytes: patternBytes(50, 0),
      outputRel: `${STORAGE_KEY}/web.mp4`,
      outputBytes: patternBytes(20, 5),
    });

    // Simulate a rescan that finds the source changed: the conversions row
    // still records the old stat, so the effective-playable computation in
    // `upsertItem` no longer counts it, and the item's own `playable` stays
    // false (no direct-play codec either).
    upsertItem(app.db, makeItem({ size: SOURCE_SIZE + 1, mtime_ms: SOURCE_MTIME + 1 }), 2000);

    const res = await getMedia(app, cookie, id);
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(await res.text()), { error: 'not_playable' });
  } finally {
    await app.close();
  }
});

test('GET /media/:id: a fresh row whose copy file was removed answers 404 not_found, never the source', async () => {
  const { app, cookie } = await setup();
  try {
    const id = await seedConvertedItem(app, {
      sourceBytes: patternBytes(50, 0),
      outputRel: `${STORAGE_KEY}/web.mp4`,
      // outputBytes omitted: the row is fresh and playable, but no file
      // exists under CONVERT_DIR (deleted by hand).
    });

    const res = await getMedia(app, cookie, id);
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(await res.text()), { error: 'not_found' });
  } finally {
    await app.close();
  }
});

test('GET /media/:id: a fresh playable row with output_rel NULL answers 404 not_found, never the source', async () => {
  const { app, cookie } = await setup();
  try {
    const id = await seedConvertedItem(app, {
      sourceBytes: patternBytes(50, 0),
      outputRel: `${STORAGE_KEY}/web.mp4`,
      outputBytes: patternBytes(20, 5),
    });
    app.db.prepare('UPDATE conversions SET output_rel = NULL WHERE rel_path = ?').run(SOURCE_REL);

    const res = await getMedia(app, cookie, id);
    assert.equal(res.status, 404);
    assert.deepEqual(JSON.parse(await res.text()), { error: 'not_found' });
  } finally {
    await app.close();
  }
});

test('PUT /api/progress/:id: a converted item is resumable (200, not not_resumable)', async () => {
  const { app, cookie } = await setup();
  try {
    const id = await seedConvertedItem(app, {
      sourceBytes: patternBytes(50, 0),
      outputRel: `${STORAGE_KEY}/web.mp4`,
      outputBytes: patternBytes(20, 5),
    });

    const res = await fetch(`${app.baseUrl}/api/progress/${id}`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ position: 10, duration: 100 }),
    });
    assert.equal(res.status, 200);
  } finally {
    await app.close();
  }
});
