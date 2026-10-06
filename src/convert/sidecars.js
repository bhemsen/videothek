// @ts-check

/**
 * Verifies and publishes the converter's WebVTT sidecars
 * (`docs/specs/spec-converter-adapter.md`, "Prior decisions"). A failing
 * sidecar costs a note, never the copy.
 */

import path from 'node:path';
import { open, stat, readdir, unlink, rename } from 'node:fs/promises';
import { resolveMediaPath } from '../media/paths.js';

/** @typedef {{ path: string, stream: number, language: string }} SidecarEntry */
/** @typedef {{ file: string, lang: string | null }} PublishedSidecar */

export const MAX_SIDECARS = 20;
export const MAX_SIDECAR_BYTES = 5 * 1024 * 1024;
const MAX_NOTES = 5;
const NOTE_MAX_LENGTH = 200;
const LANG_PATTERN = /^[a-z]{2,3}(-[a-z0-9]{1,8})*$/;
const OLD_SIDECAR = /^sub-\d+\.vtt$/;

/**
 * @param {string} language
 * @returns {string | null} the language tag to store, `null` for `und`/malformed.
 */
export function sidecarLang(language) {
  return LANG_PATTERN.test(language) && language !== 'und' ? language : null;
}

/**
 * @param {string} outDir - the job's realpath'd `out/`.
 * @param {string} entryPath - absolute path from the converter record.
 * @returns {string | null} `entryPath` relative to `outDir`, `null` when outside.
 */
function relativeInside(outDir, entryPath) {
  const rel = path.relative(outDir, entryPath);
  const escapes = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return rel === '' || escapes ? null : rel;
}

/**
 * @param {string} file
 * @returns {Promise<boolean>} whether the file starts with an optional BOM and `WEBVTT`.
 */
async function hasWebvttSignature(file) {
  const handle = await open(file, 'r');
  try {
    const buf = Buffer.alloc(10);
    const { bytesRead } = await handle.read(buf, 0, 10, 0);
    const head = buf.subarray(0, bytesRead);
    const body = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? head.subarray(3) : head;
    if (body.subarray(0, 6).toString('latin1') !== 'WEBVTT') return false;
    return body.length === 6 || [0x20, 0x09, 0x0d, 0x0a].includes(body[6]);
  } finally {
    await handle.close();
  }
}

/**
 * @param {string} outDir
 * @param {SidecarEntry} entry
 * @returns {Promise<{ ok: true, abs: string, size: number } | { ok: false, reason: string }>}
 */
async function verifyOne(outDir, entry) {
  const rel = relativeInside(outDir, entry.path);
  if (rel === null) return { ok: false, reason: 'outside the output directory' };
  if (!entry.path.toLowerCase().endsWith('.vtt')) return { ok: false, reason: 'not a .vtt file' };
  const abs = await resolveMediaPath(outDir, rel);
  if (abs === null) return { ok: false, reason: 'not found inside the output directory' };
  try {
    const info = await stat(abs);
    if (!info.isFile()) return { ok: false, reason: 'not a regular file' };
    if (info.size > MAX_SIDECAR_BYTES) return { ok: false, reason: 'larger than 5 MiB' };
    if (!(await hasWebvttSignature(abs))) return { ok: false, reason: 'missing WEBVTT signature' };
    return { ok: true, abs, size: info.size };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

/**
 * @param {string} publishDir
 * @returns {Promise<void>} removes previous `sub-<n>.vtt` files (best effort).
 */
async function removeOldSidecars(publishDir) {
  let names;
  try {
    names = await readdir(publishDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (OLD_SIDECAR.test(name)) await unlink(path.join(publishDir, name)).catch(() => {});
  }
}

/**
 * Removes old `sub-*.vtt` from the publish directory, verifies the converter's
 * sidecars and renames the kept ones to `sub-<n>.vtt`. Never throws.
 * @param {{ outDir: string, publishDir: string, sidecars: SidecarEntry[] }} input
 *   `outDir` must be the realpath'd job output directory.
 * @returns {Promise<{ published: PublishedSidecar[], bytes: number, notes: string[] }>}
 */
export async function publishSidecars({ outDir, publishDir, sidecars }) {
  await removeOldSidecars(publishDir);
  /** @type {PublishedSidecar[]} */
  const published = [];
  /** @type {string[]} */
  const notes = [];
  let bytes = 0;
  for (const [index, entry] of sidecars.entries()) {
    if (published.length >= MAX_SIDECARS) {
      notes.push(`Dropped subtitle stream ${entry.stream}: more than ${MAX_SIDECARS} subtitle files`);
      continue;
    }
    const verified = await verifyOne(outDir, entry);
    const file = `sub-${published.length}.vtt`;
    const moved = verified.ok
      ? await rename(verified.abs, path.join(publishDir, file)).then(() => true, () => false)
      : false;
    if (verified.ok && moved) {
      published.push({ file, lang: sidecarLang(entry.language) });
      bytes += verified.size;
    } else {
      const reason = verified.ok ? 'could not be stored' : verified.reason;
      notes.push(`Dropped subtitle stream ${entry.stream} (entry ${index}): ${reason}`);
    }
  }
  return { published, bytes, notes: notes.slice(0, MAX_NOTES).map((n) => n.slice(0, NOTE_MAX_LENGTH)) };
}
