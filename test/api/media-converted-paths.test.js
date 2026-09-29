// @ts-check

/**
 * `GET /media/:id` converted-copy path handling
 * (docs/specs/spec-conversion-core.md, "Serving"): `output_rel` containment
 * inside `CONVERT_DIR`, `CONVERT_DIR` never read for an unconverted item,
 * and subtitle sidecars still served from the source folder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { upsertItem } from '../../src/db/library-repo.js';
import { getMedia, makeItem, patternBytes, seedConvertedItem, setup, STORAGE_KEY, writeFileDeep } from './media-converted-helpers.js';

test('GET /media/:id: an output_rel escaping CONVERT_DIR to a real, readable file answers 404 not_found (containment)', async () => {
  const { app, cookie } = await setup();
  try {
    // A readable file just outside CONVERT_DIR, so only the containment
    // check (not a missing file) can turn `../evil.mp4` into a 404.
    await writeFileDeep(path.join(app.config.convertDir, '..', 'evil.mp4'), patternBytes(10, 7));
    const decoyRel = 'Filme/Decoy.mp4';
    const decoyAbs = path.join(app.config.mediaRoot, decoyRel);
    await writeFileDeep(decoyAbs, patternBytes(10, 3));
    // Absolute (with drive on win32) and rooted-without-drive spellings of
    // that same existing file; either would stream it without containment.
    const rooted = decoyAbs.replace(/^[a-zA-Z]:/, '').split(path.sep).join('/');

    const variants = ['../evil.mp4', decoyAbs, rooted];
    for (const [i, badOutputRel] of variants.entries()) {
      const relPath = `Filme/Tampered ${i}.mkv`;
      const id = await seedConvertedItem(app, {
        sourceBytes: patternBytes(10, 0),
        outputRel: badOutputRel,
        storageKey: String(i + 1).repeat(64),
        item: { rel_path: relPath, title: relPath, sort_title: relPath },
      });

      const res = await getMedia(app, cookie, id);
      assert.equal(res.status, 404, badOutputRel);
      assert.deepEqual(JSON.parse(await res.text()), { error: 'not_found' }, badOutputRel);
    }
  } finally {
    await app.close();
  }
});

test('GET /media/:id: config.convertDir is read only for an item with a fresh conversion', async () => {
  const { app, cookie } = await setup();
  try {
    let convertDirReads = 0;
    app.deps.config = new Proxy(app.config, {
      get(target, key, receiver) {
        if (key === 'convertDir') convertDirReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });

    const directBytes = patternBytes(15, 11);
    await writeFileDeep(path.join(app.config.mediaRoot, 'Filme/Direct.mp4'), directBytes);
    const directId = upsertItem(
      app.db,
      makeItem({ rel_path: 'Filme/Direct.mp4', ext: 'mp4', playable: true, title: 'Direct', sort_title: 'direct' }),
      1000
    );
    const direct = await getMedia(app, cookie, directId);
    assert.equal(direct.status, 200);
    assert.deepEqual(Buffer.from(await direct.arrayBuffer()), directBytes, 'unconverted item streams the source');
    assert.equal(convertDirReads, 0, 'CONVERT_DIR not read for an unconverted item');

    // Positive control: the proxy is really the config the route consults.
    const convertedId = await seedConvertedItem(app, {
      sourceBytes: patternBytes(50, 0),
      outputRel: `${STORAGE_KEY}/web.mp4`,
      outputBytes: patternBytes(20, 5),
    });
    const converted = await getMedia(app, cookie, convertedId);
    assert.equal(converted.status, 200);
    await converted.arrayBuffer();
    assert.ok(convertDirReads > 0, 'CONVERT_DIR read for a converted item');
  } finally {
    await app.close();
  }
});

test('GET /media/:id/subtitles/:n: a converted item still serves the sidecar from the source folder', async () => {
  const { app, cookie } = await setup();
  try {
    const outputRel = `${STORAGE_KEY}/web.mp4`;
    const id = await seedConvertedItem(app, { sourceBytes: patternBytes(50, 0), outputRel, outputBytes: patternBytes(20, 5) });
    const sourceVtt = Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nQuelle\n', 'utf8');
    await writeFileDeep(path.join(app.config.mediaRoot, 'Filme/Show (2020).de.vtt'), sourceVtt);
    // Decoy next to the copy: must never be served.
    const copyVtt = Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nKopie\n', 'utf8');
    await writeFileDeep(path.join(app.config.convertDir, STORAGE_KEY, 'web.de.vtt'), copyVtt);

    const res = await fetch(`${app.baseUrl}/media/${id}/subtitles/0`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/vtt; charset=utf-8');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), sourceVtt);
  } finally {
    await app.close();
  }
});
