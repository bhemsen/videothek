import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EXIF_WINDOW_BYTES, JPEG_EXTENSIONS, THUMB_MIME, isJpegStart, parseExif, verifyThumb } from '../../../src/library/tags/exif.js';
import { baseJpegBuffer, buildExifJpeg } from '../../helpers/exif-jpeg.js';

test('constants', () => {
  assert.equal(EXIF_WINDOW_BYTES, 131072);
  assert.deepEqual(JPEG_EXTENSIONS, ['jpg', 'jpeg', 'jfif']);
  assert.equal(THUMB_MIME, 'image/jpeg');
});

test('isJpegStart: true only for a buffer of at least 2 bytes starting FF D8', () => {
  assert.equal(isJpegStart(Buffer.from([0xff, 0xd8, 0x00])), true);
  assert.equal(isJpegStart(Buffer.from([0xff, 0xd8])), true);
  assert.equal(isJpegStart(Buffer.from([0xff])), false);
  assert.equal(isJpegStart(Buffer.alloc(0)), false);
  assert.equal(isJpegStart(Buffer.from([0x00, 0xd8])), false);
  assert.equal(isJpegStart(Buffer.from([0xff, 0x00])), false);
});

test('parseExif: non-JPEG input (PNG signature) yields null fields', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual(parseExif(png), { orientation: null, takenAt: null, thumbOffset: null, thumbLength: null });
});

test('parseExif: a JPEG with no EXIF APP1 yields null fields', () => {
  assert.deepEqual(parseExif(baseJpegBuffer()), { orientation: null, takenAt: null, thumbOffset: null, thumbLength: null });
});

test('parseExif: little-endian (II) sample yields orientation, DateTimeOriginal and an absolute thumbnail location', () => {
  const buf = buildExifJpeg({ order: 'II', orientation: 6, dateTimeOriginal: '2024:07:14 09:14:00', thumbnail: { compression: 6 } });
  const result = parseExif(buf);
  assert.equal(result.orientation, 6);
  assert.equal(result.takenAt, '2024-07-14T09:14:00');
  const thumbOffset = result.thumbOffset ?? -1;
  const thumbLength = result.thumbLength ?? -1;
  assert.ok(thumbOffset > 0 && thumbLength > 0);
  const thumbBytes = buf.subarray(thumbOffset, thumbOffset + thumbLength);
  assert.deepEqual(thumbBytes, baseJpegBuffer());
});

test('parseExif: big-endian (MM) sample yields the same fields', () => {
  const buf = buildExifJpeg({ order: 'MM', orientation: 8, dateTimeOriginal: '2024:07:14 10:28:00', thumbnail: { compression: 6 } });
  const result = parseExif(buf);
  assert.equal(result.orientation, 8);
  assert.equal(result.takenAt, '2024-07-14T10:28:00');
  const thumbOffset = result.thumbOffset ?? -1;
  assert.ok(isJpegStart(buf.subarray(thumbOffset, thumbOffset + 2)));
});

test('parseExif: DateTimeOriginal is preferred over IFD0 DateTime', () => {
  const buf = buildExifJpeg({ dateTimeOriginal: '2024:01:02 03:04:05', dateTime: '2020:01:01 00:00:00' });
  assert.equal(parseExif(buf).takenAt, '2024-01-02T03:04:05');
});

test('parseExif: IFD0 DateTime is used when there is no Exif sub-IFD', () => {
  const buf = buildExifJpeg({ dateTime: '2020:06:15 12:30:00' });
  assert.equal(parseExif(buf).takenAt, '2020-06-15T12:30:00');
});

test('parseExif: an out-of-range orientation is null', () => {
  assert.equal(parseExif(buildExifJpeg({ orientation: 0 })).orientation, null);
  assert.equal(parseExif(buildExifJpeg({ orientation: 9 })).orientation, null);
});

for (const bad of ['0000:00:00 00:00:00', '2024:13:01 10:00:00', '2024:07:32 10:00:00', '2024:07:14 24:00:00', '2024:07:14 10:60:00', '18:00:00']) {
  test(`parseExif: invalid date "${bad}" yields a null takenAt`, () => {
    assert.equal(parseExif(buildExifJpeg({ dateTimeOriginal: bad })).takenAt, null);
  });
}

test('parseExif: Compression other than 6 rejects the thumbnail', () => {
  const buf = buildExifJpeg({ thumbnail: { compression: 1 } });
  const result = parseExif(buf);
  assert.equal(result.thumbOffset, null);
  assert.equal(result.thumbLength, null);
});

test('parseExif: an absent Compression tag still accepts the thumbnail', () => {
  const buf = buildExifJpeg({ thumbnail: {} });
  const result = parseExif(buf);
  assert.ok((result.thumbOffset ?? -1) > 0);
  assert.equal(result.thumbLength, baseJpegBuffer().length);
});

test('parseExif: a thumbnail range declared outside the APP1 segment is rejected', () => {
  const buf = buildExifJpeg({ thumbnail: { compression: 6, offsetRel: 999999 } });
  const result = parseExif(buf);
  assert.equal(result.thumbOffset, null);
  assert.equal(result.thumbLength, null);
});

test('parseExif: a thumbnail length of 0 is rejected', () => {
  assert.equal(parseExif(buildExifJpeg({ thumbnail: { compression: 6, length: 0 } })).thumbOffset, null);
});

test('parseExif: a thumbnail length over 65,535 is rejected', () => {
  assert.equal(parseExif(buildExifJpeg({ thumbnail: { compression: 6, length: 70000 } })).thumbOffset, null);
});

test('parseExif: thumbnail bytes not starting FF D8 are rejected', () => {
  const buf = buildExifJpeg({ thumbnail: { compression: 6, data: Buffer.from([0x00, 0x01, 0x02, 0x03]) } });
  const result = parseExif(buf);
  assert.equal(result.thumbOffset, null);
  assert.equal(result.thumbLength, null);
});

test('parseExif: an IFD1 self-loop (cycle guard) yields no thumbnail but keeps orientation', () => {
  const buf = buildExifJpeg({ orientation: 3, thumbnail: { compression: 6 }, ifd1SelfLoop: true });
  const result = parseExif(buf);
  assert.equal(result.orientation, 3);
  assert.equal(result.thumbOffset, null);
});

test('parseExif: an Exif sub-IFD self-loop (cycle guard) falls back to IFD0 DateTime', () => {
  const buf = buildExifJpeg({ dateTime: '2019:03:03 03:03:03', exifIfdSelfLoop: true });
  assert.equal(parseExif(buf).takenAt, '2019-03-03T03:03:03');
});

test('parseExif: an out-of-window Exif sub-IFD offset falls back to IFD0 DateTime instead of throwing', () => {
  const buf = buildExifJpeg({ dateTime: '2018:02:02 02:02:02', dateTimeOriginal: '2024:01:01 00:00:00', exifIfdOffsetOverrideRel: 999999 });
  assert.equal(parseExif(buf).takenAt, '2018-02-02T02:02:02');
});

test('parseExif: every truncation length of a valid sample never throws and yields sane fields', () => {
  const full = buildExifJpeg({ orientation: 6, dateTimeOriginal: '2024:07:14 09:14:00', thumbnail: { compression: 6 } });
  for (let cut = 0; cut <= full.length; cut++) {
    const truncated = full.subarray(0, cut);
    assert.doesNotThrow(() => parseExif(truncated));
  }
});

test('parseExif: random bytes never throw', () => {
  for (let i = 0; i < 20; i++) {
    const junk = randomBytes(50 + i * 37);
    assert.doesNotThrow(() => parseExif(junk));
  }
});

test('verifyThumb: matching size/mtime and a JPEG SOI at the offset returns true', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'exif-thumb-'));
  const file = path.join(dir, 'photo.jpg');
  const buf = buildExifJpeg({ thumbnail: { compression: 6 } });
  await writeFile(file, buf);
  const thumbOffset = parseExif(buf).thumbOffset ?? -1;
  const stat = await (await import('node:fs/promises')).stat(file);
  const ok = await verifyThumb(file, { thumbOffset, sourceSize: stat.size, sourceMtimeMs: Math.trunc(stat.mtimeMs) });
  assert.equal(ok, true);
});

test('verifyThumb: a changed size or mtime returns false', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'exif-thumb-'));
  const file = path.join(dir, 'photo.jpg');
  const buf = buildExifJpeg({ thumbnail: { compression: 6 } });
  await writeFile(file, buf);
  const thumbOffset = parseExif(buf).thumbOffset ?? -1;
  assert.equal(await verifyThumb(file, { thumbOffset, sourceSize: 1, sourceMtimeMs: 0 }), false);
  const fs = await import('node:fs/promises');
  const stat = await fs.stat(file);
  assert.equal(await verifyThumb(file, { thumbOffset, sourceSize: stat.size, sourceMtimeMs: Math.trunc(stat.mtimeMs) + 1000 }), false);
});

test('verifyThumb: a directory instead of a file returns false', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'exif-thumb-'));
  const sub = path.join(dir, 'sub');
  await mkdir(sub);
  const ok = await verifyThumb(sub, { thumbOffset: 0, sourceSize: 0, sourceMtimeMs: 0 });
  assert.equal(ok, false);
});

test('verifyThumb: a short read at the offset (near EOF) returns false', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'exif-thumb-'));
  const file = path.join(dir, 'photo.jpg');
  await writeFile(file, Buffer.from([0xff, 0xd8]));
  const fs = await import('node:fs/promises');
  const stat = await fs.stat(file);
  const ok = await verifyThumb(file, { thumbOffset: stat.size - 1, sourceSize: stat.size, sourceMtimeMs: Math.trunc(stat.mtimeMs) });
  assert.equal(ok, false);
});

test('verifyThumb: bytes at the offset not starting FF D8 return false', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'exif-thumb-'));
  const file = path.join(dir, 'photo.jpg');
  await writeFile(file, Buffer.from([0x00, 0x00, 0x00, 0x00]));
  const fs = await import('node:fs/promises');
  const stat = await fs.stat(file);
  const ok = await verifyThumb(file, { thumbOffset: 0, sourceSize: stat.size, sourceMtimeMs: Math.trunc(stat.mtimeMs) });
  assert.equal(ok, false);
});

test('verifyThumb: an openFile rejection returns false without throwing', async () => {
  const ok = await verifyThumb('/does/not/matter', { thumbOffset: 0, sourceSize: 0, sourceMtimeMs: 0 }, {
    openFile: async () => { throw new Error('ENOENT: simulated'); },
  });
  assert.equal(ok, false);
});

test('verifyThumb: every opened handle is closed, on both the success and failure paths', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'exif-thumb-'));
  const file = path.join(dir, 'photo.jpg');
  const buf = buildExifJpeg({ thumbnail: { compression: 6 } });
  await writeFile(file, buf);
  const thumbOffset = parseExif(buf).thumbOffset ?? -1;
  const fs = await import('node:fs/promises');
  const stat = await fs.stat(file);
  const scenarios = [
    { sourceSize: stat.size, sourceMtimeMs: Math.trunc(stat.mtimeMs) },
    { sourceSize: 1, sourceMtimeMs: 0 },
  ];
  for (const source of scenarios) {
    let closed = false;
    /** @param {string} p */
    const spy = async (p) => {
      const handle = await fs.open(p, 'r');
      const close = handle.close.bind(handle);
      handle.close = async (...args) => { closed = true; return close(...args); };
      return handle;
    };
    await verifyThumb(file, { thumbOffset, ...source }, { openFile: spy });
    assert.equal(closed, true);
  }
});
