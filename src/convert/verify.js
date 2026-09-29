// @ts-check

/**
 * Output verification for on-demand conversion
 * (`docs/specs/spec-conversion-core.md`, "Verification"). Checks a
 * converter-reported output path before the queue publishes it: containment
 * inside the job's `out/` dir (no symlink escape), a regular non-empty file
 * with the target's extension, then a target-specific format check - the
 * strict MP4 codec sniff for `web`, a small magic-byte check for `flac`/`opus`.
 * Pure I/O, no DB and no process spawning.
 */

import path from 'node:path';
import { lstat, open } from 'node:fs/promises';
import { resolveMediaPath } from '../media/paths.js';
import { sniffMp4Codecs } from '../library/tags/mp4-codec.js';
import { resolvePlayable } from '../library/parsers/compat.js';
import { TARGETS } from './targets.js';

/** @typedef {import('./targets.js').ConversionTarget} ConversionTarget */

/**
 * @typedef {{ ok: true, path: string } | { ok: false, error: 'converter_output_invalid' | 'not_browser_safe' }} VerifyResult
 */

const FLAC_MAGIC = Buffer.from('fLaC', 'ascii');
const OGG_MAGIC = Buffer.from('OggS', 'ascii');
const OPUS_HEAD_MAGIC = Buffer.from('OpusHead', 'ascii');

/**
 * Verifies a converter's reported output for one job
 * (`docs/specs/spec-conversion-core.md`, "Verification", steps 1-3).
 *
 * @param {object} params
 * @param {string} params.output - absolute path the converter reported as its
 *   `converted` record's `output` field.
 * @param {string} params.outDir - the realpath'd `out/` directory passed to
 *   the converter as its output directory for this job.
 * @param {ConversionTarget} params.target
 * @returns {Promise<VerifyResult>} `{ ok: true, path }` with the resolved
 *   realpath the queue must publish, or `{ ok: false, error }` with
 *   `converter_output_invalid` (containment, missing/empty/wrong-type file, or
 *   wrong extension) or `not_browser_safe` (the format check failed).
 */
export async function verifyOutput({ output, outDir, target }) {
  const resolved = await resolveMediaPath(outDir, path.relative(outDir, output));
  if (resolved === null) return { ok: false, error: 'converter_output_invalid' };

  const stat = await lstat(resolved).catch(() => null);
  const ext = path.extname(resolved).slice(1).toLowerCase();
  if (!stat || !stat.isFile() || stat.size === 0 || ext !== TARGETS[target].ext) {
    return { ok: false, error: 'converter_output_invalid' };
  }

  const safe = await checkFormat(resolved, target, stat.size);
  return safe ? { ok: true, path: resolved } : { ok: false, error: 'not_browser_safe' };
}

/**
 * Target-specific format check (step 3): the strict MP4 sniff for `web`
 * (unlike the scanner, an unresolvable sniff - "unknown" - fails here), or a
 * magic-byte check for `flac`/`opus`.
 *
 * @param {string} absPath - the resolved, existing regular file.
 * @param {ConversionTarget} target
 * @param {number} size
 * @returns {Promise<boolean>}
 */
async function checkFormat(absPath, target, size) {
  if (target === 'web') {
    const codecs = await sniffMp4Codecs(absPath);
    if (codecs === null || codecs.video.length === 0) return false;
    return resolvePlayable({ ext: TARGETS.web.ext, size, codecs });
  }
  if (target === 'flac') return matchesMagic(absPath, 0, FLAC_MAGIC);
  return isOpusHead(absPath);
}

/**
 * Whether the bytes at `offset` in the file equal `expected`.
 *
 * @param {string} absPath
 * @param {number} offset
 * @param {Buffer} expected
 * @returns {Promise<boolean>}
 */
async function matchesMagic(absPath, offset, expected) {
  const fh = await open(absPath, 'r').catch(() => null);
  if (!fh) return false;
  try {
    const buf = Buffer.alloc(expected.length);
    const { bytesRead } = await fh.read(buf, 0, expected.length, offset);
    return bytesRead === expected.length && buf.equals(expected);
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Ogg Opus magic check (not the codec sniff): bytes 0-3 are `OggS`; byte 26 is
 * `page_segments` = n; bytes `27+n`..`34+n` are `OpusHead`.
 *
 * @param {string} absPath
 * @returns {Promise<boolean>}
 */
async function isOpusHead(absPath) {
  const fh = await open(absPath, 'r').catch(() => null);
  if (!fh) return false;
  try {
    const head = Buffer.alloc(27);
    const { bytesRead: headRead } = await fh.read(head, 0, head.length, 0);
    if (headRead !== head.length || !head.subarray(0, 4).equals(OGG_MAGIC)) return false;
    const pageSegments = head[26];
    const opusHead = Buffer.alloc(OPUS_HEAD_MAGIC.length);
    const { bytesRead: opusRead } = await fh.read(opusHead, 0, opusHead.length, 27 + pageSegments);
    return opusRead === opusHead.length && opusHead.equals(OPUS_HEAD_MAGIC);
  } finally {
    await fh.close().catch(() => {});
  }
}
