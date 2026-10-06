// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { publishSidecars, sidecarLang, MAX_SIDECAR_BYTES } from '../../src/convert/sidecars.js';
import { getConversion } from '../../src/db/conversions.js';
import { interpretAndPublish } from '../../src/convert/publish.js';
import { REL_PATH, fakeConfig, makeTempDir, convertedFlac, setup } from '../helpers/conversion-job-fixtures.js';

/**
 * @param {import('node:test').TestContext} t
 * @returns {Promise<{ outDir: string, publishDir: string }>}
 */
async function dirs(t) {
  const outDir = await fs.realpath(await makeTempDir(t, 'vt-sc-out-'));
  const publishDir = await fs.realpath(await makeTempDir(t, 'vt-sc-pub-'));
  return { outDir, publishDir };
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {string | Buffer} content
 * @returns {Promise<string>} the file path
 */
async function put(dir, name, content) {
  const file = path.join(dir, name);
  await fs.writeFile(file, content);
  return file;
}

test('two valid sidecars publish as sub-0/sub-1 with lang rules (und -> null, pt-br kept)', async (t) => {
  const { outDir, publishDir } = await dirs(t);
  const a = await put(outDir, 'a.por.vtt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('WEBVTT\n\n')]));
  const b = await put(outDir, 'b.und.vtt', 'WEBVTT\n');
  const res = await publishSidecars({
    outDir, publishDir,
    sidecars: [{ path: a, stream: 2, language: 'pt-br' }, { path: b, stream: 3, language: 'und' }],
  });
  assert.deepEqual(res.published, [{ file: 'sub-0.vtt', lang: 'pt-br' }, { file: 'sub-1.vtt', lang: null }]);
  assert.equal(res.bytes, 11 + 7);
  assert.deepEqual(res.notes, []);
  assert.equal(await fs.readFile(path.join(publishDir, 'sub-1.vtt'), 'utf8'), 'WEBVTT\n');
});

test('sidecarLang accepts tags and rejects und and malformed values', () => {
  assert.equal(sidecarLang('eng'), 'eng');
  assert.equal(sidecarLang('pt-br'), 'pt-br');
  assert.equal(sidecarLang('und'), null);
  assert.equal(sidecarLang('EN'), null);
  assert.equal(sidecarLang(''), null);
});

test('invalid entries are dropped with a note and do not consume an index', async (t) => {
  const { outDir, publishDir } = await dirs(t);
  const outside = await put(publishDir, 'outside.vtt', 'WEBVTT\n');
  const noSig = await put(outDir, 'nosig.vtt', 'HELLO\n');
  const big = await put(outDir, 'big.vtt', Buffer.concat([Buffer.from('WEBVTT\n'), Buffer.alloc(MAX_SIDECAR_BYTES)]));
  const notVtt = await put(outDir, 'x.srt', 'WEBVTT\n');
  await fs.mkdir(path.join(outDir, 'dir.vtt'));
  const good = await put(outDir, 'good.vtt', 'WEBVTT\n');
  const res = await publishSidecars({
    outDir, publishDir,
    sidecars: [
      { path: outside, stream: 1, language: 'eng' },
      { path: noSig, stream: 2, language: 'eng' },
      { path: big, stream: 3, language: 'eng' },
      { path: notVtt, stream: 4, language: 'eng' },
      { path: path.join(outDir, 'dir.vtt'), stream: 5, language: 'eng' },
      { path: path.join(outDir, 'missing.vtt'), stream: 6, language: 'eng' },
      { path: good, stream: 7, language: 'deu' },
    ],
  });
  assert.deepEqual(res.published, [{ file: 'sub-0.vtt', lang: 'deu' }]);
  assert.equal(res.notes.length, 5);
  assert.ok(res.notes.every((n) => n.length <= 200));
  assert.match(res.notes[0], /outside/);
  assert.match(res.notes[1], /WEBVTT/);
  assert.match(res.notes[2], /5 MiB/);
});

test('more than 20 sidecars: the rest is dropped with a note', async (t) => {
  const { outDir, publishDir } = await dirs(t);
  const entries = [];
  for (let i = 0; i < 22; i += 1) {
    entries.push({ path: await put(outDir, `s${i}.vtt`, 'WEBVTT\n'), stream: i, language: 'eng' });
  }
  const res = await publishSidecars({ outDir, publishDir, sidecars: entries });
  assert.equal(res.published.length, 20);
  assert.equal(res.published[19].file, 'sub-19.vtt');
  assert.equal(res.notes.length, 2);
  assert.match(res.notes[0], /more than 20/);
});

test('previous sub-*.vtt are removed, other files stay', async (t) => {
  const { outDir, publishDir } = await dirs(t);
  await put(publishDir, 'sub-0.vtt', 'old');
  await put(publishDir, 'sub-7.vtt', 'old');
  await put(publishDir, 'audio.flac', 'keep');
  const res = await publishSidecars({ outDir, publishDir, sidecars: [] });
  assert.deepEqual(res.published, []);
  assert.deepEqual((await fs.readdir(publishDir)).sort(), ['audio.flac']);
});

test('interpretAndPublish stores sidecars, appends own notes and counts their bytes in output_size', async (t) => {
  const fx = await setup(t);
  const outDir = await makeTempDir(t, 'vt-sc-job-');
  const result = await convertedFlac({ outDir }, ['conv note']);
  const good = await put(outDir, 'a.eng.vtt', 'WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n');
  result.records[0].sidecars = [
    { path: good, stream: 1, language: 'eng' },
    { path: path.join(outDir, 'gone.vtt'), stream: 2, language: 'eng' },
  ];
  await put(path.join(fx.convertDirReal, fx.row.storage_key), 'sub-5.vtt', 'stale').catch(async () => {
    await fs.mkdir(path.join(fx.convertDirReal, fx.row.storage_key), { recursive: true });
    await put(path.join(fx.convertDirReal, fx.row.storage_key), 'sub-5.vtt', 'stale');
  });
  const opts = /** @type {any} */ ({
    db: fx.db, config: fakeConfig(fx.mediaRoot, fx.convertDirReal), now: () => 7, row: fx.row, convertDirReal: fx.convertDirReal,
  });
  const source = { path: await fs.realpath(fx.source.abs), size: fx.source.size, mtimeMs: fx.source.mtimeMs };
  assert.deepEqual(await interpretAndPublish(opts, { outDir, result, source }), { status: 'playable' });
  const stored = getConversion(fx.db, REL_PATH);
  assert.deepEqual(JSON.parse(stored?.sidecars ?? 'null'), [{ file: 'sub-0.vtt', lang: 'eng' }]);
  const notes = JSON.parse(stored?.notes ?? 'null');
  assert.equal(notes[0], 'conv note');
  assert.match(notes[1], /Dropped subtitle stream 2/);
  const dir = path.join(fx.convertDirReal, fx.row.storage_key);
  const main = (await fs.stat(path.join(dir, 'audio.flac'))).size;
  assert.equal(stored?.output_size, main + (await fs.stat(path.join(dir, 'sub-0.vtt'))).size);
  await assert.rejects(fs.stat(path.join(dir, 'sub-5.vtt')));
});

test('containment: symlink out of out/, ../ path and signature edge cases', async (t) => {
  const { outDir, publishDir } = await dirs(t);
  const secret = await put(publishDir, 'secret.vtt', 'WEBVTT\n');
  const link = path.join(outDir, 'link.vtt');
  let linked = true;
  await fs.symlink(secret, link).catch(() => fs.symlink(secret, link, 'junction')).catch(() => { linked = false; });
  const dots = await put(outDir, '..a.vtt', 'WEBVTT');
  const bad = await put(outDir, 'bad.vtt', 'WEBVTTX\n');
  const tab = await put(outDir, 'tab.vtt', 'WEBVTT\tfoo');
  const res = await publishSidecars({
    outDir, publishDir,
    sidecars: [
      { path: link, stream: 1, language: 'eng' },
      { path: path.join(outDir, '..', path.basename(publishDir), 'secret.vtt'), stream: 2, language: 'eng' },
      { path: bad, stream: 3, language: 'eng' },
      { path: dots, stream: 4, language: 'eng' },
      { path: tab, stream: 5, language: 'eng' },
    ],
  });
  assert.deepEqual(res.published.map((p) => p.file), ['sub-0.vtt', 'sub-1.vtt']);
  assert.equal(res.notes.length, linked ? 3 : 2);
  const joined = res.notes.join('\n');
  assert.match(joined, /stream 2/);
  assert.match(joined, /stream 3/);
  if (linked) assert.match(joined, /stream 1/);
});
