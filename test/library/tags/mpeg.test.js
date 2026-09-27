// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMpegDurationMs } from '../../../src/library/tags/mpeg.js';
import { readId3v2 } from '../../../src/library/tags/id3v2.js';
import {
  ENCODING, buildMpegFrame, withXingHeader, withVbriHeader, buildId3v2Tag, buildFrame, textFrameBody, apicFrameBody,
  makeReadAt, instrumentReadAt,
} from '../../helpers/mp3-fixture.js';

const SAMPLES_PER_FRAME = 1152;
const SAMPLE_RATE = 32000;

test('CBR: N silent frames after an ID3v2 tag give the exact byte/bitrate duration (within ±1 s)', async () => {
  const tag = buildId3v2Tag({ frames: [] });
  const frames = Array.from({ length: 100 }, () => buildMpegFrame());
  const file = Buffer.concat([tag, ...frames]);
  const expectedMs = (100 * SAMPLES_PER_FRAME / SAMPLE_RATE) * 1000;
  const durationMs = await readMpegDurationMs(makeReadAt(file), tag.length, file.length);
  assert.ok(durationMs !== null);
  assert.ok(Math.abs(durationMs - expectedMs) <= 1000, `${durationMs} vs ${expectedMs}`);
});

test('Xing frame count wins over the CBR byte estimate', async () => {
  const first = withXingHeader(buildMpegFrame(), { frames: 1000 });
  const file = Buffer.concat([first, buildMpegFrame()]);
  const durationMs = await readMpegDurationMs(makeReadAt(file), 0, file.length);
  assert.equal(durationMs, (1000 * SAMPLES_PER_FRAME / SAMPLE_RATE) * 1000);
});

test('VBRI frame count wins over the CBR byte estimate', async () => {
  const first = withVbriHeader(buildMpegFrame(), { frames: 500 });
  const file = Buffer.concat([first, buildMpegFrame()]);
  const durationMs = await readMpegDurationMs(makeReadAt(file), 0, file.length);
  assert.equal(durationMs, (500 * SAMPLES_PER_FRAME / SAMPLE_RATE) * 1000);
});

test('VBRI frame count of 0 is treated as absent, falling back to the CBR estimate', async () => {
  const first = withVbriHeader(buildMpegFrame(), { frames: 0 });
  const file = Buffer.concat([first, buildMpegFrame()]);
  const durationMs = await readMpegDurationMs(makeReadAt(file), 0, file.length);
  const expectedMs = Math.round((file.length * 8 / (32 * 1000)) * 1000);
  assert.equal(durationMs, expectedMs);
});

test('garbage after the tag (no valid sync) yields null, never throws', async () => {
  const tag = buildId3v2Tag({ frames: [] });
  const file = Buffer.concat([tag, Buffer.alloc(4096, 0x20)]);
  await assert.doesNotReject(readMpegDurationMs(makeReadAt(file), tag.length, file.length));
  assert.equal(await readMpegDurationMs(makeReadAt(file), tag.length, file.length), null);
});

test('random garbage never fabricates a duration from an unconfirmed sync byte', async () => {
  // A lone 0xFF sync-like pair happens fairly often in random bytes; a real
  // frame header is only accepted once a second, matching header is found
  // at the offset its own frame length implies. 300 random 8 KiB buffers
  // (no ID3 tag, no real frames) must all yield null. Seeded, so the run is reproducible.
  let seed = 0x2545f491;
  const nextByte = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed & 0xff; };
  for (let i = 0; i < 300; i++) {
    const buf = Buffer.from(Array.from({ length: 8192 }, nextByte));
    const durationMs = await readMpegDurationMs(makeReadAt(buf), 0, buf.length);
    assert.equal(durationMs, null, `iteration ${i} fabricated a duration from random bytes`);
  }
});

test('readId3v2 + readMpegDurationMs together stay within 256 KiB, even for a budget-exhausting v2.3 unsync tag', async () => {
  const title = buildFrame({ id: 'TIT2', version: 3, body: textFrameBody(ENCODING.LATIN1, 'Titel') });
  const apic = buildFrame({ id: 'APIC', version: 3, body: apicFrameBody({ data: Buffer.alloc(5 * 1024 * 1024, 0xab) }) });
  const tag = buildId3v2Tag({ version: 3, unsynchronisation: true, frames: [title, apic] });
  const file = Buffer.concat([tag, ...Array.from({ length: 100 }, () => buildMpegFrame())]);
  const { readAt, bytesRead } = instrumentReadAt(makeReadAt(file));
  const result = await readId3v2(readAt);
  assert.equal(result?.fields.TIT2, 'Titel');
  const durationMs = await readMpegDurationMs(readAt, result?.tagEnd ?? 0, file.length);
  assert.ok(bytesRead() <= 256 * 1024, `read ${bytesRead()} bytes`);
  assert.ok(durationMs !== null && Math.abs(durationMs - 3600) <= 1000, `duration ${durationMs}`);
});

test('audioStart at or past the file end yields null, never throws', async () => {
  const file = Buffer.alloc(10);
  await assert.doesNotReject(readMpegDurationMs(makeReadAt(file), 10, 10));
  assert.equal(await readMpegDurationMs(makeReadAt(file), 10, 10), null);
});
