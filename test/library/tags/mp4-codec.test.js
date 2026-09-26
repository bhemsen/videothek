import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sniffMp4Codecs } from '../../../src/library/tags/mp4-codec.js';
import { boxBuf, moovBox, mdat64Box } from '../../helpers/mp4-boxes.js';

/**
 * @param {import('node:test').TestContext} t
 * @param {Buffer[]} chunks
 * @returns {Promise<string>}
 */
async function writeMp4(t, chunks) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mp4-codec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'test.mp4');
  await writeFile(file, Buffer.concat(chunks));
  return file;
}

test('avc1 + mp4a is a fully allow-listed track set', async (t) => {
  const file = await writeMp4(t, [
    moovBox([
      { handlerType: 'vide', fourcc: 'avc1' },
      { handlerType: 'soun', fourcc: 'mp4a' },
    ]),
  ]);
  const codecs = await sniffMp4Codecs(file);
  assert.deepEqual(codecs, { video: ['avc1'], audio: ['mp4a'] });
});

test('hvc1 video track is sniffed but not allow-listed', async (t) => {
  const file = await writeMp4(t, [
    moovBox([
      { handlerType: 'vide', fourcc: 'hvc1' },
      { handlerType: 'soun', fourcc: 'mp4a' },
    ]),
  ]);
  const codecs = await sniffMp4Codecs(file);
  assert.deepEqual(codecs, { video: ['hvc1'], audio: ['mp4a'] });
});

test('ac-3 audio track is sniffed but not allow-listed', async (t) => {
  const file = await writeMp4(t, [
    moovBox([
      { handlerType: 'vide', fourcc: 'avc1' },
      { handlerType: 'soun', fourcc: 'ac-3' },
    ]),
  ]);
  const codecs = await sniffMp4Codecs(file);
  assert.deepEqual(codecs, { video: ['avc1'], audio: ['ac-3'] });
});

test('alac audio track is sniffed but not allow-listed', async (t) => {
  const file = await writeMp4(t, [moovBox([{ handlerType: 'soun', fourcc: 'alac' }])]);
  const codecs = await sniffMp4Codecs(file);
  assert.deepEqual(codecs, { video: [], audio: ['alac'] });
});

test('mp4v video track is sniffed but not allow-listed', async (t) => {
  const file = await writeMp4(t, [moovBox([{ handlerType: 'vide', fourcc: 'mp4v' }])]);
  const codecs = await sniffMp4Codecs(file);
  assert.deepEqual(codecs, { video: ['mp4v'], audio: [] });
});

test('a moov box after a 64-bit-size mdat is still found', async (t) => {
  const file = await writeMp4(t, [
    mdat64Box(2048),
    moovBox([
      { handlerType: 'vide', fourcc: 'avc1' },
      { handlerType: 'soun', fourcc: 'mp4a' },
    ]),
  ]);
  const codecs = await sniffMp4Codecs(file);
  assert.deepEqual(codecs, { video: ['avc1'], audio: ['mp4a'] });
});

test('non-vide/soun handler types are ignored', async (t) => {
  const file = await writeMp4(t, [
    moovBox([
      { handlerType: 'vide', fourcc: 'avc1' },
      { handlerType: 'hint', fourcc: 'rtp ' },
      { handlerType: 'tmcd', fourcc: 'tmcd' },
    ]),
  ]);
  const codecs = await sniffMp4Codecs(file);
  assert.deepEqual(codecs, { video: ['avc1'], audio: [] });
});

test('missing moov yields null without throwing', async (t) => {
  const file = await writeMp4(t, [boxBuf('ftyp', Buffer.from('isom'))]);
  const codecs = await sniffMp4Codecs(file);
  assert.equal(codecs, null);
});

test('truncated file yields null without throwing', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mp4-codec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'truncated.mp4');
  // Fewer than 8 bytes: not even one full box header fits.
  await writeFile(file, Buffer.from([0, 0, 0]));
  const codecs = await sniffMp4Codecs(file);
  assert.equal(codecs, null);
});

test('an oversized box (declared size beyond the file) yields null without throwing', async (t) => {
  // 'free' box header declaring a size far larger than the actual file.
  const header = Buffer.alloc(8);
  header.writeUInt32BE(1_000_000, 0);
  header.write('free', 4, 'latin1');
  const file = await writeMp4(t, [header]);
  const codecs = await sniffMp4Codecs(file);
  assert.equal(codecs, null);
});

test('a looping run of tiny boxes past the per-level box limit yields null without hanging', async (t) => {
  const tinyBoxes = [];
  for (let i = 0; i < 100; i += 1) tinyBoxes.push(boxBuf('free'));
  const file = await writeMp4(t, [...tinyBoxes, moovBox([{ handlerType: 'vide', fourcc: 'avc1' }])]);
  const codecs = await sniffMp4Codecs(file);
  assert.equal(codecs, null);
});

test('a nonexistent file yields null without throwing', async () => {
  const codecs = await sniffMp4Codecs(path.join(tmpdir(), 'does-not-exist-mp4-codec-test.mp4'));
  assert.equal(codecs, null);
});

test('the sniffer opens the file only with flag "r" (a read-only file still sniffs)', async (t) => {
  const file = await writeMp4(t, [
    moovBox([
      { handlerType: 'vide', fourcc: 'avc1' },
      { handlerType: 'soun', fourcc: 'mp4a' },
    ]),
  ]);
  // Opening with any write-implying flag ('r+', 'w', 'a', ...) would throw on
  // a read-only file and the sniffer would (incorrectly) report null.
  await chmod(file, 0o444);
  t.after(() => chmod(file, 0o666).catch(() => {}));
  const codecs = await sniffMp4Codecs(file);
  assert.deepEqual(codecs, { video: ['avc1'], audio: ['mp4a'] });
});
