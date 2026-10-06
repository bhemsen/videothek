// @ts-check

/**
 * Converted subtitle tracks: item JSON and `GET /media/:id/subtitles/:n`
 * share `listItemSubtitles`, so indices agree (docs/specs/spec-converter-adapter.md).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import {
  patternBytes,
  seedConvertedItem,
  setup,
  STORAGE_KEY,
  writeFileDeep,
} from './media-converted-helpers.js';

const SIDECARS = JSON.stringify([
  { file: 'sub-0.vtt', lang: 'eng' },
  { file: 'sub-1.vtt', lang: null },
]);

/**
 * @param {Awaited<ReturnType<typeof setup>>} ctx
 * @param {string} sidecars
 * @returns {Promise<number>}
 */
async function seed({ app }, sidecars) {
  const id = await seedConvertedItem(app, {
    sourceBytes: patternBytes(20),
    outputRel: `${STORAGE_KEY}/web.mp4`,
    outputBytes: patternBytes(10, 3),
    sidecars,
  });
  await writeFileDeep(path.join(app.config.mediaRoot, 'Filme/Show (2020).de.vtt'), Buffer.from('WEBVTT\n\nsource'));
  await writeFileDeep(path.join(app.config.convertDir, STORAGE_KEY, 'sub-0.vtt'), Buffer.from('WEBVTT\n\nc0'));
  await writeFileDeep(path.join(app.config.convertDir, STORAGE_KEY, 'sub-1.vtt'), Buffer.from('WEBVTT\n\nc1'));
  return id;
}

/**
 * @param {Awaited<ReturnType<typeof setup>>} ctx
 * @param {number} id
 * @returns {Promise<Array<{ index: number, lang: string | null, label: string | null }>>}
 */
async function itemSubtitles({ app, cookie }, id) {
  const res = await fetch(`${app.baseUrl}/api/library/items/${id}`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  return (await res.json()).subtitles;
}

/**
 * @param {Awaited<ReturnType<typeof setup>>} ctx
 * @param {number} id
 * @param {number} n
 */
function getSub({ app, cookie }, id, n) {
  return fetch(`${app.baseUrl}/media/${id}/subtitles/${n}`, { headers: { Cookie: cookie } });
}

test('subtitles: source tracks first, then converted; item JSON and route agree on indices', async () => {
  const ctx = await setup();
  try {
    const id = await seed(ctx, SIDECARS);
    const list = await itemSubtitles(ctx, id);
    assert.deepEqual(list, [
      { index: 0, lang: 'de', label: 'de' },
      { index: 1, lang: 'eng', label: 'eng' },
      { index: 2, lang: null, label: null },
    ]);
    assert.ok(!JSON.stringify(list).includes(ctx.app.config.convertDir), 'no path leaked');
    const expected = ['source', 'c0', 'c1'];
    for (const [n, text] of expected.entries()) {
      const res = await getSub(ctx, id, n);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/vtt; charset=utf-8');
      assert.match(await res.text(), new RegExp(`${text}$`));
    }
    assert.equal((await getSub(ctx, id, 3)).status, 404);
  } finally {
    await ctx.app.close();
  }
});

test('subtitles: a stale conversion contributes no converted tracks', async () => {
  const ctx = await setup();
  try {
    const id = await seed(ctx, SIDECARS);
    ctx.app.db.prepare('UPDATE library_items SET size = size + 1 WHERE id = ?').run(id);
    assert.deepEqual((await itemSubtitles(ctx, id)).map((t) => t.index), [0]);
    assert.equal((await getSub(ctx, id, 1)).status, 404);
  } finally {
    await ctx.app.close();
  }
});

test('subtitles: an item without a conversion lists only source tracks', async () => {
  const ctx = await setup();
  try {
    const id = await seed(ctx, SIDECARS);
    ctx.app.db.prepare('DELETE FROM conversions').run();
    assert.deepEqual((await itemSubtitles(ctx, id)).map((t) => t.index), [0]);
  } finally {
    await ctx.app.close();
  }
});

test('subtitles: tampered sidecars JSON yields no converted track and 404', async () => {
  const ctx = await setup();
  try {
    const tampered = [
      '{not json',
      '{"file":"sub-0.vtt"}',
      JSON.stringify([{ file: '../x.vtt', lang: 'en' }]),
      JSON.stringify([{ file: '../sub-0.vtt', lang: 'en' }]),
      JSON.stringify([{ file: 'evil.vtt', lang: 'en' }, { file: 'sub-100.vtt' }, { file: 'sub-0.txt' }, { file: 5 }, null]),
      JSON.stringify([{ file: 'sub-9.vtt', lang: 'en' }]), // valid name, file missing
    ];
    const id = await seed(ctx, tampered[0]);
    for (const sidecars of tampered) {
      ctx.app.db.prepare('UPDATE conversions SET sidecars = ?').run(sidecars);
      assert.deepEqual((await itemSubtitles(ctx, id)).map((t) => t.index), [0], sidecars);
      assert.equal((await getSub(ctx, id, 1)).status, 404, sidecars);
    }
  } finally {
    await ctx.app.close();
  }
});

test('subtitles: a symlinked sub-0.vtt pointing outside CONVERT_DIR is dropped', async (t) => {
  const ctx = await setup();
  try {
    const { app } = ctx;
    const id = await seedConvertedItem(app, {
      sourceBytes: patternBytes(20),
      outputRel: `${STORAGE_KEY}/web.mp4`,
      outputBytes: patternBytes(10),
      sidecars: JSON.stringify([{ file: 'sub-0.vtt', lang: 'en' }]),
    });
    const outside = path.join(app.config.mediaRoot, 'outside.vtt');
    await writeFileDeep(outside, Buffer.from('WEBVTT\n\nsecret'));
    await mkdir(path.join(app.config.convertDir, STORAGE_KEY), { recursive: true });
    try {
      await symlink(outside, path.join(app.config.convertDir, STORAGE_KEY, 'sub-0.vtt'));
    } catch {
      t.skip('symlink creation not permitted');
      return;
    }
    assert.deepEqual(await itemSubtitles(ctx, id), []);
    assert.equal((await getSub(ctx, id, 0)).status, 404);
  } finally {
    await ctx.app.close();
  }
});
