// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readId3v2 } from '../../../src/library/tags/id3v2.js';
import {
  ENCODING, buildId3v2Tag, buildFrame, textFrameBody, apicFrameBody, makeReadAt, instrumentReadAt,
} from '../../helpers/mp3-fixture.js';

/** @param {import('../../helpers/mp3-fixture.js').ReadAt} readAt @returns {ReturnType<typeof readId3v2>} */
const read = (readAt) => readId3v2(readAt);

for (const version of [3, 4]) {
  for (const [name, encoding] of Object.entries(ENCODING)) {
    test(`v2.${version} TIT2 in ${name} decodes "Ärzte"`, async () => {
      const frame = buildFrame({ id: 'TIT2', body: textFrameBody(encoding, 'Ärzte'), version });
      const tag = buildId3v2Tag({ version, frames: [frame] });
      const result = await read(makeReadAt(tag));
      assert.equal(result?.fields.TIT2, 'Ärzte');
      assert.equal(result?.version, version);
    });
  }
}

test('first value of a \\0-separated multi-value frame wins', async () => {
  const frame = buildFrame({ id: 'TPE1', body: textFrameBody(ENCODING.UTF8, ['Alice', 'Bob']) });
  const result = await read(makeReadAt(buildId3v2Tag({ frames: [frame] })));
  assert.equal(result?.fields.TPE1, 'Alice');
});

test('TRCK "n/total" is kept as the raw string', async () => {
  const frame = buildFrame({ id: 'TRCK', body: textFrameBody(ENCODING.LATIN1, '3/12') });
  const result = await read(makeReadAt(buildId3v2Tag({ frames: [frame] })));
  assert.equal(result?.fields.TRCK, '3/12');
});

test('extended header is skipped, the frame after it is still found', async () => {
  const frame = buildFrame({ id: 'TALB', body: textFrameBody(ENCODING.UTF8, 'Album') });
  const tag = buildId3v2Tag({ version: 4, extendedHeader: true, frames: [frame] });
  const result = await read(makeReadAt(tag));
  assert.equal(result?.fields.TALB, 'Album');
});

test('v2.3 whole-tag unsynchronisation is reversed and pictures are ignored', async () => {
  const title = buildFrame({ id: 'TIT2', body: textFrameBody(ENCODING.LATIN1, 'Fuÿball'), version: 3 });
  const apic = buildFrame({ id: 'APIC', body: apicFrameBody({ data: Buffer.from('cover') }), version: 3 });
  const artist = buildFrame({ id: 'TPE1', body: textFrameBody(ENCODING.LATIN1, 'Band'), version: 3 });
  const tag = buildId3v2Tag({ version: 3, unsynchronisation: true, frames: [title, apic, artist] });
  const result = await read(makeReadAt(tag));
  assert.equal(result?.fields.TIT2, 'Fuÿball');
  assert.equal(result?.fields.TPE1, 'Band');
  assert.equal(result?.picture, null);
});

test('iTunes non-synchsafe v2.4 frame size falls back to plain big-endian', async () => {
  const title = buildFrame({
    id: 'TIT2', version: 4, forcePlainSize: true, body: textFrameBody(ENCODING.UTF8, 'x'.repeat(198)),
  });
  const artist = buildFrame({ id: 'TPE1', version: 4, body: textFrameBody(ENCODING.UTF8, 'Band') });
  const result = await read(makeReadAt(buildId3v2Tag({ version: 4, frames: [title, artist] })));
  assert.equal(result?.fields.TIT2, 'x'.repeat(198));
  assert.equal(result?.fields.TPE1, 'Band');
});

test('APIC prefers the front-cover type and reports a correct PictureRef offset', async () => {
  const other = Buffer.from('other-picture-bytes');
  const front = Buffer.from('front-cover-bytes');
  const apicOther = buildFrame({ id: 'APIC', body: apicFrameBody({ pictureType: 0, data: other }) });
  const apicFront = buildFrame({ id: 'APIC', body: apicFrameBody({ pictureType: 3, data: front }) });
  const tag = buildId3v2Tag({ frames: [apicOther, apicFront] });
  const result = await read(makeReadAt(tag));
  assert.ok(result);
  assert.ok(result.picture);
  const ref = result.picture;
  assert.equal(tag.subarray(ref.offset, ref.offset + ref.length).toString('latin1'), 'front-cover-bytes');
  assert.equal(ref.mime, 'image/jpeg');
});

test('a 5 MiB APIC costs at most 256 KiB of reads; the frame after it is found', async () => {
  const title = buildFrame({ id: 'TIT2', body: textFrameBody(ENCODING.UTF8, 'Title') });
  const picture = Buffer.alloc(5 * 1024 * 1024, 0xab);
  const apic = buildFrame({ id: 'APIC', body: apicFrameBody({ pictureType: 3, data: picture }) });
  const albumArtist = buildFrame({ id: 'TPE2', body: textFrameBody(ENCODING.UTF8, 'Album Artist') });
  const tag = buildId3v2Tag({ frames: [title, apic, albumArtist] });
  const { readAt, bytesRead } = instrumentReadAt(makeReadAt(tag));
  const result = await read(readAt);
  assert.equal(result?.fields.TIT2, 'Title');
  assert.equal(result?.fields.TPE2, 'Album Artist');
  assert.equal(result?.picture?.length, picture.length);
  assert.ok(bytesRead() <= 256 * 1024, `read ${bytesRead()} bytes`);
});

test('robustness: truncated, past-EOF, zero-size and random buffers never throw or loop', async () => {
  const zeroSize = buildFrame({ id: 'TIT2', body: Buffer.alloc(0) });
  const artist = buildFrame({ id: 'TPE1', body: textFrameBody(ENCODING.UTF8, 'Band') });
  const zeroSizeTag = buildId3v2Tag({ frames: [zeroSize, artist] });
  const zeroResult = await read(makeReadAt(zeroSizeTag));
  assert.equal(zeroResult?.fields.TPE1, 'Band');

  const fullTag = buildId3v2Tag({ frames: [artist] });
  await assert.doesNotReject(read(makeReadAt(fullTag.subarray(0, fullTag.length - 5))));
  await assert.doesNotReject(read(makeReadAt(Buffer.alloc(0))));
  assert.equal(await read(makeReadAt(Buffer.alloc(0))), null);

  for (let i = 0; i < 20; i++) {
    await assert.doesNotReject(read(makeReadAt(randomBytes(i * 7))));
  }
  const fakeHeader = Buffer.from('ID3\x04\x00\x00\x00\x00\x01\x00', 'latin1');
  await assert.doesNotReject(read(makeReadAt(Buffer.concat([fakeHeader, randomBytes(128)]))));
});
