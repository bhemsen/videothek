import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyOutput } from '../../src/convert/verify.js';
import { moovBox } from '../helpers/mp4-boxes.js';

/** @param {string} prefix */
async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * @param {string} dir
 * @param {string} name
 * @param {Buffer} content
 */
async function writeOutputFile(dir, name, content) {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, content);
  return filePath;
}

/**
 * @param {unknown} err
 * @returns {err is NodeJS.ErrnoException}
 */
function isErrnoException(err) {
  return err instanceof Error && 'code' in err;
}

/** An MP4 with one `avc1` video track and one `mp4a` audio track. */
function avcMp4Buffer() {
  return moovBox([
    { handlerType: 'vide', fourcc: 'avc1' },
    { handlerType: 'soun', fourcc: 'mp4a' },
  ]);
}

/**
 * A minimal Ogg page carrying an `OpusHead` payload, with `pageSegments`
 * bytes in its (unread) segment table (spec-conversion-core.md,
 * "Verification": bytes 0-3 `OggS`, byte 26 `page_segments` = n, bytes
 * `27+n`..`34+n` `OpusHead`).
 * @param {number} pageSegments
 */
function opusPageBuffer(pageSegments) {
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'ascii');
  header[26] = pageSegments;
  const segmentTable = Buffer.alloc(pageSegments, 1);
  const payload = Buffer.concat([Buffer.from('OpusHead', 'ascii'), Buffer.alloc(11)]);
  return Buffer.concat([header, segmentTable, payload]);
}

test('verifyOutput: an avc1+mp4a MP4 passes', async (t) => {
  const outDir = await makeTempDir('vt-verify-');
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const output = await writeOutputFile(outDir, 'web.mp4', avcMp4Buffer());

  const result = await verifyOutput({ output, outDir, target: 'web' });

  assert.deepEqual(result, { ok: true, path: await fs.realpath(output) });
});

test('verifyOutput: an hvc1 video track fails not_browser_safe', async (t) => {
  const outDir = await makeTempDir('vt-verify-');
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const buf = moovBox([
    { handlerType: 'vide', fourcc: 'hvc1' },
    { handlerType: 'soun', fourcc: 'mp4a' },
  ]);
  const output = await writeOutputFile(outDir, 'web.mp4', buf);

  const result = await verifyOutput({ output, outDir, target: 'web' });

  assert.deepEqual(result, { ok: false, error: 'not_browser_safe' });
});

test('verifyOutput: an audio-only MP4 (no video track) fails not_browser_safe', async (t) => {
  const outDir = await makeTempDir('vt-verify-');
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const buf = moovBox([{ handlerType: 'soun', fourcc: 'mp4a' }]);
  const output = await writeOutputFile(outDir, 'web.mp4', buf);

  const result = await verifyOutput({ output, outDir, target: 'web' });

  assert.deepEqual(result, { ok: false, error: 'not_browser_safe' });
});

test('verifyOutput: an unknown MP4 sniff (no moov box) fails not_browser_safe', async (t) => {
  const outDir = await makeTempDir('vt-verify-');
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const output = await writeOutputFile(outDir, 'web.mp4', Buffer.from('not a real mp4 - no moov here'));

  const result = await verifyOutput({ output, outDir, target: 'web' });

  assert.deepEqual(result, { ok: false, error: 'not_browser_safe' });
});

test('verifyOutput: a zero-byte MP4 fails converter_output_invalid', async (t) => {
  const outDir = await makeTempDir('vt-verify-');
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const output = await writeOutputFile(outDir, 'web.mp4', Buffer.alloc(0));

  const result = await verifyOutput({ output, outDir, target: 'web' });

  assert.deepEqual(result, { ok: false, error: 'converter_output_invalid' });
});

test('verifyOutput: FLAC magic passes', async (t) => {
  const outDir = await makeTempDir('vt-verify-');
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const content = Buffer.concat([Buffer.from('fLaC', 'ascii'), Buffer.alloc(16)]);
  const output = await writeOutputFile(outDir, 'audio.flac', content);

  const result = await verifyOutput({ output, outDir, target: 'flac' });

  assert.deepEqual(result, { ok: true, path: await fs.realpath(output) });
});

test('verifyOutput: wrong FLAC magic fails not_browser_safe', async (t) => {
  const outDir = await makeTempDir('vt-verify-');
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const content = Buffer.concat([Buffer.from('XLaC', 'ascii'), Buffer.alloc(16)]);
  const output = await writeOutputFile(outDir, 'audio.flac', content);

  const result = await verifyOutput({ output, outDir, target: 'flac' });

  assert.deepEqual(result, { ok: false, error: 'not_browser_safe' });
});

test('verifyOutput: Ogg Opus with page_segments = 1 passes', async (t) => {
  const outDir = await makeTempDir('vt-verify-');
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const output = await writeOutputFile(outDir, 'audio.opus', opusPageBuffer(1));

  const result = await verifyOutput({ output, outDir, target: 'opus' });

  assert.deepEqual(result, { ok: true, path: await fs.realpath(output) });
});

test('verifyOutput: Ogg Opus with page_segments > 1 passes', async (t) => {
  const outDir = await makeTempDir('vt-verify-');
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const output = await writeOutputFile(outDir, 'audio.opus', opusPageBuffer(5));

  const result = await verifyOutput({ output, outDir, target: 'opus' });

  assert.deepEqual(result, { ok: true, path: await fs.realpath(output) });
});

test('verifyOutput: wrong Opus magic fails not_browser_safe', async (t) => {
  const outDir = await makeTempDir('vt-verify-');
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const output = await writeOutputFile(outDir, 'audio.opus', Buffer.alloc(64));

  const result = await verifyOutput({ output, outDir, target: 'opus' });

  assert.deepEqual(result, { ok: false, error: 'not_browser_safe' });
});

test('verifyOutput: an upper-case .MP4 extension passes (case-insensitive)', async (t) => {
  const outDir = await makeTempDir('vt-verify-');
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const output = await writeOutputFile(outDir, 'web.MP4', avcMp4Buffer());

  const result = await verifyOutput({ output, outDir, target: 'web' });

  assert.deepEqual(result, { ok: true, path: await fs.realpath(output) });
});

test('verifyOutput: an output outside outDir fails converter_output_invalid', async (t) => {
  const outDir = await makeTempDir('vt-verify-');
  const outside = await makeTempDir('vt-verify-outside-');
  t.after(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  const output = await writeOutputFile(outside, 'web.mp4', avcMp4Buffer());

  const result = await verifyOutput({ output, outDir, target: 'web' });

  assert.deepEqual(result, { ok: false, error: 'converter_output_invalid' });
});

test('verifyOutput: a symlink escaping outDir fails converter_output_invalid', async (t) => {
  const outDir = await makeTempDir('vt-verify-');
  const outside = await makeTempDir('vt-verify-outside-');
  t.after(async () => {
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  const target = await writeOutputFile(outside, 'secret.mp4', avcMp4Buffer());
  const link = path.join(outDir, 'web.mp4');

  try {
    await fs.symlink(target, link, 'file');
  } catch (err) {
    if (isErrnoException(err) && err.code === 'EPERM') {
      t.skip('file symlinks require elevated privileges on this platform');
      return;
    }
    throw err;
  }

  const result = await verifyOutput({ output: link, outDir, target: 'web' });

  assert.deepEqual(result, { ok: false, error: 'converter_output_invalid' });
});
