import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFlac } from '../../../src/library/tags/flac.js';
import { buildFlacFile, readAtFromBuffer, countingReadAt } from '../../helpers/flac-fixture.js';

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

test('readFlac: stays within its read budget even with an oversized comment block', async () => {
  const buf = buildFlacFile({
    includeFrames: false,
    vorbisPaddingBytes: 70 * 1024,
    pictures: [{ type: 3, mime: 'image/png', data: Buffer.from('cover') }],
  });
  const { readAt, bytesRead } = countingReadAt(buf);
  const result = await readFlac(readAt, buf.length);
  assert.ok(result?.picture);
  assert.equal(result.picture.mime, 'image/png');
  assert.ok(bytesRead() <= 256 * 1024, `expected <= 256 KiB read, got ${bytesRead()}`);
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
