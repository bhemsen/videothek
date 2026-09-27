// @ts-check
// Central tag -> field mapping and dispatch: the only module that opens
// audio files for tag reading. Combines the ID3v2 + MPEG duration readers
// (mp3) and the FLAC reader (flac) behind one budgeted, file-backed `readAt`
// per call; every other extension yields an all-null result without any I/O.
//
// @see docs/specs/spec-music-audiobooks.md — "Reader interfaces", "Fields
// read", "Read budget".

import { open as fsOpen } from 'node:fs/promises';
import { readId3v2 } from './id3v2.js';
import { readMpegDurationMs } from './mpeg.js';
import { readFlac } from './flac.js';

/** @typedef {import('./id3v2.js').ReadAt} ReadAt */
/** @typedef {{ offset: number, length: number, mime: string }} PictureRef */
/** @typedef {(path: string) => Promise<import('node:fs/promises').FileHandle>} OpenFile */
/**
 * @typedef {object} AudioTags
 * @property {string | null} title
 * @property {string | null} artist
 * @property {string | null} albumArtist
 * @property {string | null} album
 * @property {number | null} trackNo
 * @property {number | null} discNo
 * @property {number | null} year
 * @property {number | null} durationMs
 * @property {'id3v2' | 'flac' | null} format
 */

const NULL_TAGS = Object.freeze({
  title: null, artist: null, albumArtist: null, album: null,
  trackNo: null, discNo: null, year: null, durationMs: null, format: null,
});

const defaultOpenFile = (/** @type {string} */ path) => fsOpen(path, 'r');

/**
 * Reads and maps the fields this app shows out of an `mp3` (ID3v2 + MPEG
 * duration) or `flac` (FLAC metadata) file; every other extension yields an
 * all-null result without opening the file. Opens `absPath` with flag `'r'`
 * only; the handle is closed in `finally`. Rejects only on an open/read I/O
 * error — the format-specific readers themselves never throw.
 *
 * @param {string} absPath absolute path to the audio file
 * @param {{ ext: string, size: number }} info lower-case extension (without
 *   the dot, as stored on `library_items`) and the file's size in bytes
 *   (avoids a redundant `stat`)
 * @param {{ openFile?: OpenFile }} [deps] `openFile` is a test seam
 *   (default: `fs.open(absPath, 'r')`)
 * @returns {Promise<AudioTags>}
 */
export async function readAudioTags(absPath, { ext, size }, { openFile = defaultOpenFile } = {}) {
  const lowerExt = ext.toLowerCase();
  if (lowerExt !== 'mp3' && lowerExt !== 'flac') return { ...NULL_TAGS };

  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let fh;
  try {
    fh = await openFile(absPath);
    const readAt = makeFileReadAt(fh);
    return lowerExt === 'mp3' ? await readMp3Tags(readAt, size) : await readFlacTags(readAt, size);
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Reads a picture reference from an mp3's `APIC` frame or a flac's
 * `PICTURE` block (already filtered by the format readers to
 * `image/jpeg|png|webp` and ≤ 10 MiB). Never rejects: any open/read/parse
 * error yields `null`. Every other extension yields `null` without opening
 * the file.
 *
 * @param {string} absPath absolute path to the audio file
 * @param {{ ext: string }} info lower-case extension (without the dot)
 * @param {{ openFile?: OpenFile }} [deps] `openFile` is a test seam
 *   (default: `fs.open(absPath, 'r')`)
 * @returns {Promise<PictureRef | null>}
 */
export async function readPictureRef(absPath, { ext }, { openFile = defaultOpenFile } = {}) {
  const lowerExt = ext.toLowerCase();
  if (lowerExt !== 'mp3' && lowerExt !== 'flac') return null;

  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let fh;
  try {
    fh = await openFile(absPath);
    const readAt = makeFileReadAt(fh);
    if (lowerExt === 'mp3') {
      const tag = await readId3v2(readAt);
      return tag?.picture ?? null;
    }
    const { size } = await fh.stat();
    const flac = await readFlac(readAt, size);
    return flac?.picture ?? null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Reads an mp3's ID3v2 tag and MPEG duration and maps them to `AudioTags`.
 * Duration is attempted even without a tag (scanning from byte 0).
 * @param {ReadAt} readAt @param {number} size @returns {Promise<AudioTags>} */
async function readMp3Tags(readAt, size) {
  const tag = await readId3v2(readAt);
  const durationMs = await readMpegDurationMs(readAt, tag?.tagEnd ?? 0, size);
  if (!tag) return { ...NULL_TAGS, durationMs };
  const fields = tag.fields;
  return {
    title: cleanText(fields.TIT2),
    artist: cleanText(fields.TPE1),
    albumArtist: cleanText(fields.TPE2),
    album: cleanText(fields.TALB),
    trackNo: parseLeadingInt(fields.TRCK),
    discNo: parseLeadingInt(fields.TPOS),
    year: parseYear(fields.TDRC ?? fields.TYER),
    durationMs,
    format: 'id3v2',
  };
}

/**
 * Reads a flac's Vorbis comments and STREAMINFO duration and maps them to
 * `AudioTags`. A missing/invalid `fLaC` marker yields the all-null result.
 * @param {ReadAt} readAt @param {number} size @returns {Promise<AudioTags>} */
async function readFlacTags(readAt, size) {
  const result = await readFlac(readAt, size);
  if (!result) return { ...NULL_TAGS };
  const fields = result.fields;
  return {
    title: cleanText(fields.TITLE),
    artist: cleanText(fields.ARTIST),
    albumArtist: cleanText(fields.ALBUMARTIST ?? fields['ALBUM ARTIST'] ?? fields.ALBUM_ARTIST),
    album: cleanText(fields.ALBUM),
    trackNo: parseLeadingInt(fields.TRACKNUMBER),
    discNo: parseLeadingInt(fields.DISCNUMBER),
    year: parseYear(fields.DATE ?? fields.YEAR),
    durationMs: result.durationMs,
    format: 'flac',
  };
}

/**
 * Trims a possibly-absent tag value; empty after trimming -> `null`.
 * @param {string | undefined} raw @returns {string | null} */
function cleanText(raw) {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Parses a track/disc number field (`"n"` or `"n/total"` -> `n`);
 * non-numeric or absent -> `null`.
 * @param {string | undefined} raw @returns {number | null} */
function parseLeadingInt(raw) {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const numPart = trimmed.split('/')[0];
  return /^\d+$/.test(numPart) ? Number(numPart) : null;
}

/**
 * Extracts the first four-digit run of a date/year field as a year;
 * absent, empty or digit-less -> `null`.
 * @param {string | undefined} raw @returns {number | null} */
function parseYear(raw) {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const match = trimmed.match(/\d{4}/);
  return match ? Number(match[0]) : null;
}

/**
 * Wraps an open `FileHandle` as a budgeted `readAt` seam: short buffer at
 * EOF, positional reads only (no shared cursor).
 * @param {import('node:fs/promises').FileHandle} fh @returns {ReadAt} */
function makeFileReadAt(fh) {
  return async (position, length) => {
    if (length <= 0) return Buffer.alloc(0);
    const buf = Buffer.allocUnsafe(length);
    const { bytesRead } = await fh.read(buf, 0, length, position);
    return buf.subarray(0, bytesRead);
  };
}
