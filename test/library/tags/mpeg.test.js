// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readMpegDurationMs } from '../../../src/library/tags/mpeg.js';
import { buildMpegFrame, withXingHeader, withVbriHeader, buildId3v2Tag, makeReadAt } from '../../helpers/mp3-fixture.js';

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
  // (no ID3 tag, no real frames) must all yield null.
  for (let i = 0; i < 300; i++) {
    const buf = randomBytes(8192);
    const durationMs = await readMpegDurationMs(makeReadAt(buf), 0, buf.length);
    assert.equal(durationMs, null, `iteration ${i} fabricated a duration from random bytes`);
  }
});

test('audioStart at or past the file end yields null, never throws', async () => {
  const file = Buffer.alloc(10);
  await assert.doesNotReject(readMpegDurationMs(makeReadAt(file), 10, 10));
  assert.equal(await readMpegDurationMs(makeReadAt(file), 10, 10), null);
});
