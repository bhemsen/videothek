// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, open as fsOpen } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readAudioTags, readPictureRef } from '../../../src/library/tags/index.js';
import {
  ENCODING, buildId3v2Tag, buildFrame, textFrameBody, apicFrameBody, buildMpegFrame,
} from '../../helpers/mp3-fixture.js';
import { buildFlacFile } from '../../helpers/flac-fixture.js';

const NULL_TAGS = Object.freeze({
  title: null, artist: null, albumArtist: null, album: null,
  trackNo: null, discNo: null, year: null, durationMs: null, format: null,
});

/** @param {import('node:test').TestContext} t @param {Buffer} buf @param {string} name @returns {Promise<string>} */
async function writeAudioFile(t, buf, name) {
  const dir = await mkdtemp(path.join(tmpdir(), 'audio-tags-index-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  await writeFile(file, buf);
  return file;
}

/** Wraps the real `fs.open` to spy on open count, total bytes read and close, and
 * optionally to fail every read (simulating an I/O error mid-parse).
 * @param {{ failRead?: boolean }} [opts] */
function spyOpenFile({ failRead = false } = {}) {
  let opens = 0;
  let closed = false;
  let bytesRead = 0;
  const openFile = async (/** @type {string} */ p) => {
    opens += 1;
    const handle = await fsOpen(p, 'r');
    // `any`-cast: FileHandle#read is overloaded, and a spy replacement need
    // only match the one (buffer, offset, length, position) shape this
    // module's `makeFileReadAt` actually calls.
    const anyHandle = /** @type {any} */ (handle);
    const origRead = anyHandle.read.bind(handle);
    anyHandle.read = async (/** @type {Buffer} */ buffer, /** @type {number} */ offset, /** @type {number} */ length, /** @type {number} */ position) => {
      if (failRead) throw new Error('simulated read failure');
      const result = await origRead(buffer, offset, length, position);
      bytesRead += result.bytesRead;
      return result;
    };
    const origClose = handle.close.bind(handle);
    handle.close = async (...args) => { closed = true; return origClose(...args); };
    return handle;
  };
  return { openFile, opens: () => opens, closed: () => closed, bytesRead: () => bytesRead };
}

test('readAudioTags: mp3 dispatch maps ID3v2.4 fields and MPEG duration', async (t) => {
  const frames = [
    buildFrame({ id: 'TIT2', body: textFrameBody(ENCODING.UTF8, 'Titel') }),
    buildFrame({ id: 'TPE1', body: textFrameBody(ENCODING.UTF8, 'Interpret') }),
    buildFrame({ id: 'TPE2', body: textFrameBody(ENCODING.UTF8, 'Album-Interpret') }),
    buildFrame({ id: 'TALB', body: textFrameBody(ENCODING.UTF8, 'Album') }),
    buildFrame({ id: 'TRCK', body: textFrameBody(ENCODING.UTF8, '3/12') }),
    buildFrame({ id: 'TPOS', body: textFrameBody(ENCODING.UTF8, '1') }),
    buildFrame({ id: 'TDRC', body: textFrameBody(ENCODING.UTF8, '2019-05-01') }),
  ];
  const tag = buildId3v2Tag({ version: 4, frames });
  const audio = Buffer.concat(Array.from({ length: 100 }, () => buildMpegFrame()));
  const file = await writeAudioFile(t, Buffer.concat([tag, audio]), 'track.mp3');
  const tags = await readAudioTags(file, { ext: 'mp3', size: tag.length + audio.length });
  assert.equal(tags.title, 'Titel');
  assert.equal(tags.artist, 'Interpret');
  assert.equal(tags.albumArtist, 'Album-Interpret');
  assert.equal(tags.album, 'Album');
  assert.equal(tags.trackNo, 3);
  assert.equal(tags.discNo, 1);
  assert.equal(tags.year, 2019);
  assert.equal(tags.format, 'id3v2');
  assert.ok(tags.durationMs !== null && tags.durationMs > 0);
});

test('readAudioTags: mp3 ID3v2.3 falls back to TYER; a non-numeric TRCK maps to null', async (t) => {
  const frames = [
    buildFrame({ id: 'TYER', body: textFrameBody(ENCODING.LATIN1, '1998'), version: 3 }),
    buildFrame({ id: 'TRCK', body: textFrameBody(ENCODING.LATIN1, 'A'), version: 3 }),
  ];
  const tag = buildId3v2Tag({ version: 3, frames });
  const file = await writeAudioFile(t, tag, 'legacy.mp3');
  const tags = await readAudioTags(file, { ext: 'mp3', size: tag.length });
  assert.equal(tags.year, 1998);
  assert.equal(tags.trackNo, null);
  assert.equal(tags.format, 'id3v2');
});

test('readAudioTags: an untagged mp3 (no ID3v2 header) maps to format null; duration is still resolved', async (t) => {
  const audio = Buffer.concat(Array.from({ length: 50 }, () => buildMpegFrame()));
  const file = await writeAudioFile(t, audio, 'untagged.mp3');
  const tags = await readAudioTags(file, { ext: 'mp3', size: audio.length });
  assert.equal(tags.title, null);
  assert.equal(tags.format, null);
  assert.ok(tags.durationMs !== null && tags.durationMs > 0);
});

test('readAudioTags: flac dispatch maps Vorbis fields and STREAMINFO duration', async (t) => {
  const sampleRate = 44100;
  const totalSamples = sampleRate * 2;
  const buf = buildFlacFile({
    sampleRate,
    totalSamples,
    vorbisComments: {
      TITLE: 'Flac Titel', ARTIST: 'Flac Interpret', ALBUM: 'Flac Album',
      TRACKNUMBER: '5', DISCNUMBER: '2', DATE: '2020-07-01',
    },
    includeFrames: false,
  });
  const file = await writeAudioFile(t, buf, 'track.flac');
  const tags = await readAudioTags(file, { ext: 'flac', size: buf.length });
  assert.equal(tags.title, 'Flac Titel');
  assert.equal(tags.artist, 'Flac Interpret');
  assert.equal(tags.album, 'Flac Album');
  assert.equal(tags.trackNo, 5);
  assert.equal(tags.discNo, 2);
  assert.equal(tags.year, 2020);
  assert.equal(tags.format, 'flac');
  assert.equal(tags.durationMs, Math.round((totalSamples / sampleRate) * 1000));
});

test('readAudioTags: flac album-artist key variants all map to albumArtist', async (t) => {
  for (const key of ['ALBUMARTIST', 'ALBUM ARTIST', 'ALBUM_ARTIST']) {
    const buf = buildFlacFile({ vorbisComments: { TITLE: 'T', [key]: 'Compil. Artist' }, includeFrames: false });
    const file = await writeAudioFile(t, buf, `variant-${key.replace(/\W/g, '_')}.flac`);
    const tags = await readAudioTags(file, { ext: 'flac', size: buf.length });
    assert.equal(tags.albumArtist, 'Compil. Artist', `key ${key}`);
  }
});

test('readAudioTags/readPictureRef: m4a/ogg/wav dispatch to an all-null result without opening the file', async () => {
  for (const ext of ['m4a', 'ogg', 'wav']) {
    const missing = path.join(tmpdir(), `does-not-exist-index-test.${ext}`);
    assert.deepEqual(await readAudioTags(missing, { ext, size: 12345 }), { ...NULL_TAGS });
    assert.equal(await readPictureRef(missing, { ext }), null);
  }
});

test('readAudioTags: rejects on an open I/O error for mp3 and flac', async () => {
  const missingMp3 = path.join(tmpdir(), 'nope-index-test.mp3');
  const missingFlac = path.join(tmpdir(), 'nope-index-test.flac');
  await assert.rejects(() => readAudioTags(missingMp3, { ext: 'mp3', size: 0 }));
  await assert.rejects(() => readAudioTags(missingFlac, { ext: 'flac', size: 0 }));
});

test('readAudioTags: closes the handle on success for both mp3 and flac', async (t) => {
  const tag = buildId3v2Tag({ frames: [buildFrame({ id: 'TIT2', body: textFrameBody(ENCODING.UTF8, 'T') })] });
  const mp3File = await writeAudioFile(t, tag, 'closed.mp3');
  const mp3Spy = spyOpenFile();
  await readAudioTags(mp3File, { ext: 'mp3', size: tag.length }, { openFile: mp3Spy.openFile });
  assert.equal(mp3Spy.opens(), 1);
  assert.equal(mp3Spy.closed(), true);

  const flacBuf = buildFlacFile({ includeFrames: false });
  const flacFile = await writeAudioFile(t, flacBuf, 'closed.flac');
  const flacSpy = spyOpenFile();
  await readAudioTags(flacFile, { ext: 'flac', size: flacBuf.length }, { openFile: flacSpy.openFile });
  assert.equal(flacSpy.opens(), 1);
  assert.equal(flacSpy.closed(), true);
});

test('readAudioTags: closes the handle and rejects on a read I/O error', async (t) => {
  const tag = buildId3v2Tag({ frames: [] });
  const file = await writeAudioFile(t, tag, 'read-fails.mp3');
  const spy = spyOpenFile({ failRead: true });
  await assert.rejects(() => readAudioTags(file, { ext: 'mp3', size: tag.length }, { openFile: spy.openFile }));
  assert.equal(spy.closed(), true);
});

test('readPictureRef: never rejects, on a missing file or a mid-read I/O error, and still closes the handle', async (t) => {
  const missing = path.join(tmpdir(), 'nope-index-test-pic.mp3');
  assert.equal(await readPictureRef(missing, { ext: 'mp3' }), null);

  const tag = buildId3v2Tag({ frames: [buildFrame({ id: 'APIC', body: apicFrameBody({ data: Buffer.from('x') }) })] });
  const file = await writeAudioFile(t, tag, 'read-fails-pic.mp3');
  const spy = spyOpenFile({ failRead: true });
  const result = await readPictureRef(file, { ext: 'mp3' }, { openFile: spy.openFile });
  assert.equal(result, null);
  assert.equal(spy.closed(), true);
});

test('readPictureRef: mp3 APIC pass-through normalises image/jpg and filters unsupported MIME types', async (t) => {
  const picture = Buffer.from('jpeg-bytes-here');
  const apic = buildFrame({ id: 'APIC', body: apicFrameBody({ mime: 'image/jpg', pictureType: 3, data: picture }) });
  const jpgFile = await writeAudioFile(t, buildId3v2Tag({ frames: [apic] }), 'cover.mp3');
  const ref = await readPictureRef(jpgFile, { ext: 'mp3' });
  assert.ok(ref);
  assert.equal(ref.mime, 'image/jpeg');

  const gifApic = buildFrame({ id: 'APIC', body: apicFrameBody({ mime: 'image/gif', pictureType: 3, data: Buffer.from('gif') }) });
  const gifFile = await writeAudioFile(t, buildId3v2Tag({ frames: [gifApic] }), 'unsupported.mp3');
  assert.equal(await readPictureRef(gifFile, { ext: 'mp3' }), null);
});

test('readPictureRef: flac PICTURE pass-through', async (t) => {
  const picture = Buffer.from('flac-pic-bytes');
  const buf = buildFlacFile({ pictures: [{ type: 3, mime: 'image/png', data: picture }], includeFrames: false });
  const file = await writeAudioFile(t, buf, 'cover.flac');
  const ref = await readPictureRef(file, { ext: 'flac' });
  assert.ok(ref);
  assert.equal(ref.mime, 'image/png');
  assert.equal(ref.length, picture.length);
});

test('readAudioTags: a 5 MiB embedded APIC still costs at most 256 KiB of reads (mp3)', async (t) => {
  const title = buildFrame({ id: 'TIT2', body: textFrameBody(ENCODING.UTF8, 'Title') });
  const picture = Buffer.alloc(5 * 1024 * 1024, 0xab);
  const apic = buildFrame({ id: 'APIC', body: apicFrameBody({ pictureType: 3, data: picture }) });
  const tag = buildId3v2Tag({ frames: [title, apic] });
  const audio = Buffer.concat(Array.from({ length: 20 }, () => buildMpegFrame()));
  const file = await writeAudioFile(t, Buffer.concat([tag, audio]), 'big-apic.mp3');
  const spy = spyOpenFile();
  const tags = await readAudioTags(file, { ext: 'mp3', size: tag.length + audio.length }, { openFile: spy.openFile });
  assert.equal(tags.title, 'Title');
  assert.ok(tags.durationMs !== null);
  assert.ok(spy.bytesRead() <= 256 * 1024, `read ${spy.bytesRead()} bytes`);
});

test('readAudioTags: a large embedded PICTURE still costs at most 256 KiB of reads (flac)', async (t) => {
  const picture = Buffer.alloc(1 * 1024 * 1024, 0xcd); // flac caps a PICTURE block read at 4 KiB regardless
  const buf = buildFlacFile({
    vorbisComments: { TITLE: 'Flac Big' },
    pictures: [{ type: 3, data: picture }],
    includeFrames: false,
  });
  const file = await writeAudioFile(t, buf, 'big-pic.flac');
  const spy = spyOpenFile();
  const tags = await readAudioTags(file, { ext: 'flac', size: buf.length }, { openFile: spy.openFile });
  assert.equal(tags.title, 'Flac Big');
  assert.ok(spy.bytesRead() <= 256 * 1024, `read ${spy.bytesRead()} bytes`);
});
