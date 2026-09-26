import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFlac } from '../../../src/library/tags/flac.js';
import { buildFlacFile, findFrameStart, readAtFromBuffer, countingReadAt } from '../../helpers/flac-fixture.js';
import { crc8, crc16, walkFrames } from '../../helpers/flac-frame-verify.js';

test('sanity: independent CRC-8/CRC-16 table implementation matches standard check values', () => {
  const check = Buffer.from('123456789', 'ascii');
  assert.equal(crc8(check), 0xf4);
  assert.equal(crc16(check), 0xfee8);
});

test('readFlac: exact duration from STREAMINFO', async () => {
  const buf = buildFlacFile({ sampleRate: 44100, totalSamples: 44100 * 5, includeFrames: false });
  const result = await readFlac(readAtFromBuffer(buf), buf.length);
  assert.ok(result);
  assert.equal(result.durationMs, 5000);
});

test('readFlac: total_samples 0 gives a null duration', async () => {
  const buf = buildFlacFile({ sampleRate: 44100, totalSamples: 0, includeFrames: false });
  const result = await readFlac(readAtFromBuffer(buf), buf.length);
  assert.ok(result);
  assert.equal(result.durationMs, null);
});

test('fixture + readFlac: mono audio frames have correct sync/CRC-8/CRC-16 and cover every sample', async () => {
  const config = { sampleRate: 44100, channels: 1, bitsPerSample: 16, totalSamples: 4096 * 2 + 100, blockSize: 4096 };
  const buf = buildFlacFile({ ...config, vorbisComments: { TITLE: 'Frames' } });
  const frames = walkFrames(buf, findFrameStart(buf), config);
  assert.equal(frames.length, 3, 'expected two full frames plus one short trailing frame');
  assert.equal(frames.reduce((sum, f) => sum + f.blockSize, 0), config.totalSamples);

  const result = await readFlac(readAtFromBuffer(buf), buf.length);
  assert.ok(result);
  assert.equal(result.durationMs, Math.round((config.totalSamples / config.sampleRate) * 1000));
});

test('fixture + readFlac: stereo audio frames have correct sync/CRC-8/CRC-16 and cover every sample', async () => {
  const config = { sampleRate: 48000, channels: 2, bitsPerSample: 24, totalSamples: 4096 * 5, blockSize: 4096 };
  const buf = buildFlacFile({ ...config, vorbisComments: { TITLE: 'Stereo Frames' } });
  const frames = walkFrames(buf, findFrameStart(buf), config);
  assert.equal(frames.length, 5);
  assert.equal(frames.reduce((sum, f) => sum + f.blockSize, 0), config.totalSamples);

  const result = await readFlac(readAtFromBuffer(buf), buf.length);
  assert.ok(result);
  assert.equal(result.durationMs, Math.round((config.totalSamples / config.sampleRate) * 1000));
});

test('readFlac: Vorbis keys are case-insensitive, incl. album-artist variants', async () => {
  const buf = buildFlacFile({
    includeFrames: false,
    vorbisComments: [
      ['title', 'Track Title'],
      ['Artist', 'Track Artist'],
      ['albumartist', 'A'],
      ['ALBUM ARTIST', 'B'],
      ['Album_Artist', 'C'],
    ],
  });
  const result = await readFlac(readAtFromBuffer(buf), buf.length);
  assert.ok(result);
  assert.equal(result.fields.TITLE, 'Track Title');
  assert.equal(result.fields.ARTIST, 'Track Artist');
  assert.equal(result.fields.ALBUMARTIST, 'A');
  assert.equal(result.fields['ALBUM ARTIST'], 'B');
  assert.equal(result.fields.ALBUM_ARTIST, 'C');
});

test('readFlac: a repeated key keeps its first value', async () => {
  const buf = buildFlacFile({
    includeFrames: false,
    vorbisComments: [
      ['ARTIST', 'First'],
      ['ARTIST', 'Second'],
    ],
  });
  const result = await readFlac(readAtFromBuffer(buf), buf.length);
  assert.ok(result);
  assert.equal(result.fields.ARTIST, 'First');
});

test('readFlac: a repeated key across multiple VORBIS_COMMENT blocks keeps its first value (malformed file)', async () => {
  const buf = buildFlacFile({
    includeFrames: false,
    vorbisComments: [['ARTIST', 'First']],
    extraVorbisCommentBlocks: [[['ARTIST', 'Second']]],
  });
  const result = await readFlac(readAtFromBuffer(buf), buf.length);
  assert.ok(result);
  assert.equal(result.fields.ARTIST, 'First');
});

test('readFlac: PICTURE type 3 (front cover) is preferred over an earlier picture', async () => {
  const buf = buildFlacFile({
    includeFrames: false,
    pictures: [
      { type: 0, mime: 'image/png', data: Buffer.from('other-picture-bytes') },
      { type: 3, mime: 'image/jpeg', data: Buffer.from('front-cover-bytes!!') },
    ],
  });
  const result = await readFlac(readAtFromBuffer(buf), buf.length);
  assert.ok(result?.picture);
  assert.equal(result.picture.mime, 'image/jpeg');
  assert.equal(result.picture.length, Buffer.from('front-cover-bytes!!').length);
  const bytes = buf.subarray(result.picture.offset, result.picture.offset + result.picture.length);
  assert.deepEqual(bytes, Buffer.from('front-cover-bytes!!'));
});

test('readFlac: without a front cover, the first picture is used', async () => {
  const buf = buildFlacFile({
    includeFrames: false,
    pictures: [
      { type: 4, mime: 'image/png', data: Buffer.from('first') },
      { type: 5, mime: 'image/webp', data: Buffer.from('second') },
    ],
  });
  const result = await readFlac(readAtFromBuffer(buf), buf.length);
  assert.ok(result?.picture);
  assert.equal(result.picture.mime, 'image/png');
  assert.equal(result.picture.length, Buffer.from('first').length);
});

test('readFlac: a large PICTURE payload does not prevent a later block from being found', async () => {
  const buf = buildFlacFile({
    includeFrames: false,
    pictures: [
      { type: 0, mime: 'image/png', data: Buffer.alloc(70 * 1024, 1) },
      { type: 3, mime: 'image/jpeg', data: Buffer.from('front-cover-after-large-picture') },
    ],
  });
  const result = await readFlac(readAtFromBuffer(buf), buf.length);
  assert.ok(result?.picture);
  assert.equal(result.picture.mime, 'image/jpeg');
  const bytes = buf.subarray(result.picture.offset, result.picture.offset + result.picture.length);
  assert.deepEqual(bytes, Buffer.from('front-cover-after-large-picture'));
});

test('readFlac: image/jpg is normalised to image/jpeg', async () => {
  const buf = buildFlacFile({ includeFrames: false, pictures: [{ mime: 'image/jpg', data: Buffer.from('x') }] });
  const result = await readFlac(readAtFromBuffer(buf), buf.length);
  assert.ok(result?.picture);
  assert.equal(result.picture.mime, 'image/jpeg');
});

test('readFlac: an unsupported picture mime type is ignored', async () => {
  const buf = buildFlacFile({ includeFrames: false, pictures: [{ mime: 'image/gif', data: Buffer.from('x') }] });
  const result = await readFlac(readAtFromBuffer(buf), buf.length);
  assert.ok(result);
  assert.equal(result.picture, null);
});

test('readFlac: a PICTURE block whose declared data length overruns the block is rejected', async () => {
  const mime = 'image/jpeg';
  const buf = buildFlacFile({ includeFrames: false, pictures: [{ mime, description: '', data: Buffer.from('abcd') }] });
  const mimeIndex = buf.indexOf(mime, 0, 'ascii');
  // Layout after the mime bytes: descLen(4) + description(0) + reserved(16), then the 4-byte data-length field.
  const dataLengthFieldOffset = mimeIndex + Buffer.byteLength(mime, 'ascii') + 4 + 0 + 16;
  const corrupted = Buffer.from(buf);
  corrupted.writeUInt32BE(5000, dataLengthFieldOffset); // this tiny block has nowhere near 5000 bytes left
  const result = await readFlac(readAtFromBuffer(corrupted), corrupted.length);
  assert.ok(result);
  assert.equal(result.picture, null);
});

test('readFlac: a leading ID3v2 tag is skipped without importing id3v2.js', async () => {
  const buf = buildFlacFile({
    leadingId3v2: true,
    sampleRate: 44100,
    totalSamples: 44100 * 2,
    includeFrames: false,
    vorbisComments: { TITLE: 'Behind The Tag' },
  });
  const result = await readFlac(readAtFromBuffer(buf), buf.length);
  assert.ok(result);
  assert.equal(result.fields.TITLE, 'Behind The Tag');
  assert.equal(result.durationMs, 2000);
});

test('readFlac: a leading ID3v2.4 tag with a footer is skipped correctly', async () => {
  const buf = buildFlacFile({
    leadingId3v2: { version: 4, footer: true },
    sampleRate: 44100,
    totalSamples: 44100 * 2,
    includeFrames: false,
    vorbisComments: { TITLE: 'Behind The Footer' },
  });
  const result = await readFlac(readAtFromBuffer(buf), buf.length);
  assert.ok(result);
  assert.equal(result.fields.TITLE, 'Behind The Footer');
  assert.equal(result.durationMs, 2000);
});

test('readFlac: a VORBIS_COMMENT block over 64 KiB is skipped, later blocks still found', async () => {
  const buf = buildFlacFile({
    includeFrames: false,
    vorbisPaddingBytes: 70 * 1024,
    vorbisComments: { TITLE: 'Should not appear' },
    pictures: [{ type: 3, mime: 'image/png', data: Buffer.from('cover') }],
  });
  const result = await readFlac(readAtFromBuffer(buf), buf.length);
  assert.ok(result?.picture);
  assert.equal(result.fields.TITLE, undefined);
  assert.equal(result.picture.mime, 'image/png');
});

test('readFlac: stays within its read budget even with several oversized VORBIS_COMMENT blocks', async () => {
  /** @type {() => [string, string][]} */
  const bigComments = () => [['PAD', 'x'.repeat(60 * 1024)]];
  const buf = buildFlacFile({
    includeFrames: false,
    vorbisComments: bigComments(),
    extraVorbisCommentBlocks: [bigComments(), bigComments(), bigComments(), bigComments(), bigComments()],
  });
  const { readAt, bytesRead } = countingReadAt(buf);
  const result = await readFlac(readAt, buf.length);
  assert.ok(result);
  // 6 blocks of ~60 KiB (~366 KiB attempted) comfortably exceed the 256 KiB
  // budget, so this only holds when reads are actually clamped to it.
  assert.ok(
    bytesRead() <= 256 * 1024 + 16,
    `expected the 256 KiB read budget to be honoured (within a few header bytes), got ${bytesRead()}`,
  );
});

test('readFlac: a truncated file never throws', async () => {
  const full = buildFlacFile({ sampleRate: 44100, totalSamples: 44100, includeFrames: false });
  for (const cut of [0, 4, 20, 40, 60, full.length - 1]) {
    const truncated = full.subarray(0, cut);
    await assert.doesNotReject(readFlac(readAtFromBuffer(truncated), truncated.length));
  }
});

test('readFlac: random bytes never throw and yield null', async () => {
  const junk = randomBytes(2000);
  const result = await readFlac(readAtFromBuffer(junk), junk.length);
  assert.equal(result, null);
});

test('readFlac: a non-FLAC file (no marker) yields null', async () => {
  const buf = Buffer.from('not a flac file at all', 'ascii');
  const result = await readFlac(readAtFromBuffer(buf), buf.length);
  assert.equal(result, null);
});

test('readFlac: an empty value is dropped, not stored as an empty string', async () => {
  const buf = buildFlacFile({ includeFrames: false, vorbisComments: [['TITLE', '  ']] });
  const result = await readFlac(readAtFromBuffer(buf), buf.length);
  assert.ok(result);
  assert.equal('TITLE' in result.fields, false);
});
