// @ts-check

/**
 * Dependency-free JPEG APP1/EXIF reader: orientation, capture date and the
 * IFD1 thumbnail location, plus the 2-byte JPEG SOI check and the thumbnail
 * pre-check `verifyThumb` used before serving `GET /media/:id/thumb`. Never
 * opens a file itself except in `verifyThumb`; `parseExif` is a pure buffer
 * parser and never throws.
 *
 * @see docs/specs/spec-image-gallery.md — "EXIF reader", "Capture date",
 * "Thumbnail route".
 */

import { open as fsOpen } from 'node:fs/promises';

/** @typedef {{ orientation: number | null, takenAt: string | null, thumbOffset: number | null, thumbLength: number | null }} ExifResult */
/** @typedef {{ entries: Map<number, { type: number, count: number, entryStart: number }>, next: number }} Ifd */

export const EXIF_WINDOW_BYTES = 131072;
export const JPEG_EXTENSIONS = Object.freeze(['jpg', 'jpeg', 'jfif']);
export const THUMB_MIME = 'image/jpeg';

const MAX_IFD_ENTRIES = 512;
const MAX_THUMB_LENGTH = 65535;
const APP1_MARKER = 0xe1;
const NULL_RESULT = Object.freeze({ orientation: null, takenAt: null, thumbOffset: null, thumbLength: null });
const DATE_RE = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/;

/**
 * True iff `buf` is at least 2 bytes and its first two bytes are the JPEG
 * SOI marker (`FF D8`). Nothing beyond byte 2 is inspected.
 *
 * @param {Buffer} buf
 * @returns {boolean}
 */
export function isJpegStart(buf) {
  return buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xd8;
}

/**
 * Pre-check for `GET /media/:id/thumb`: the source file must still be a
 * regular file matching the recorded size/mtime, and the recorded thumbnail
 * offset must still start with a JPEG SOI marker. Never throws; every
 * opened handle is closed.
 *
 * @param {string} path Absolute path to the source file.
 * @param {{ thumbOffset: number, sourceSize: number, sourceMtimeMs: number }} expected
 * @param {{ openFile?: (path: string) => Promise<import('node:fs/promises').FileHandle> }} [deps]
 * @returns {Promise<boolean>}
 */
export async function verifyThumb(path, { thumbOffset, sourceSize, sourceMtimeMs }, { openFile = (p) => fsOpen(p, 'r') } = {}) {
  if (!Number.isSafeInteger(thumbOffset) || thumbOffset < 0) return false;
  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let handle;
  try {
    handle = await openFile(path);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== sourceSize || Math.trunc(stat.mtimeMs) !== sourceMtimeMs) return false;
    const buf = Buffer.alloc(2);
    const { bytesRead } = await handle.read(buf, 0, 2, thumbOffset);
    return bytesRead === 2 && isJpegStart(buf);
  } catch {
    return false;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Parses orientation, capture date and the IFD1 thumbnail location from the
 * leading bytes of a JPEG file. Malformed or absent EXIF data yields `null`
 * fields; never throws.
 *
 * @param {Buffer} buf Leading bytes of a JPEG file, read from offset 0 (see
 *   `EXIF_WINDOW_BYTES` for the recommended read size).
 * @returns {ExifResult}
 */
export function parseExif(buf) {
  try {
    if (!isJpegStart(buf)) return { ...NULL_RESULT };
    const window = Math.min(buf.length, EXIF_WINDOW_BYTES);
    const app1 = findExifApp1(buf, window);
    return app1 ? readExifFromApp1(buf, app1, window) : { ...NULL_RESULT };
  } catch {
    return { ...NULL_RESULT };
  }
}

/**
 * Walks JPEG marker segments from offset 2 for the first APP1 segment whose
 * payload starts `Exif\0\0`. Stops at SOS, EOI, a non-marker byte or the
 * window end. `segmentEnd` is the segment's *declared* end (from its length
 * field), which may exceed `window` for a deliberately truncated buffer.
 * Every length-bearing marker (not just APPn/COM) is skipped the same way.
 *
 * @param {Buffer} buf
 * @param {number} window
 * @returns {{ payloadStart: number, segmentEnd: number } | null}
 */
function findExifApp1(buf, window) {
  let pos = 2;
  while (pos + 2 <= window) {
    if (buf[pos] !== 0xff) return null;
    let mpos = pos + 1;
    while (mpos < window && buf[mpos] === 0xff) mpos += 1;
    if (mpos >= window) return null;
    const marker = buf[mpos];
    pos = mpos + 1;
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / SOS: stop
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue; // RSTn / TEM: no length field
    if (pos + 2 > window) return null;
    const segLen = buf.readUInt16BE(pos);
    if (segLen < 2) return null;
    const payloadStart = pos + 2;
    const segmentEnd = pos + segLen;
    const sigEnd = Math.min(segmentEnd, window);
    if (marker === APP1_MARKER && payloadStart + 6 <= sigEnd && buf.toString('ascii', payloadStart, payloadStart + 6) === 'Exif\0\0') {
      return { payloadStart, segmentEnd };
    }
    pos = segmentEnd;
  }
  return null;
}

/**
 * Reads the TIFF/IFD structure of one APP1/EXIF segment.
 * @param {Buffer} buf @param {{ payloadStart: number, segmentEnd: number }} app1
 * @param {number} window Bytes actually available in `buf`. @returns {ExifResult}
 */
function readExifFromApp1(buf, { payloadStart, segmentEnd }, window) {
  const tiffStart = payloadStart + 6;
  const limit = Math.min(segmentEnd, window);
  if (tiffStart + 8 > limit) return { ...NULL_RESULT };
  const little = buf[tiffStart] === 0x49 && buf[tiffStart + 1] === 0x49;
  const big = buf[tiffStart] === 0x4d && buf[tiffStart + 1] === 0x4d;
  if ((!little && !big) || readU16(buf, tiffStart + 2, little) !== 42) return { ...NULL_RESULT };

  const visited = new Set();
  const ifd0 = readIfd(buf, tiffStart, readU32(buf, tiffStart + 4, little), little, limit, visited);
  if (!ifd0) return { ...NULL_RESULT };

  return {
    orientation: readShortTag(buf, ifd0, 0x0112, tiffStart, little, limit, 1, 8),
    takenAt: readTakenAt(buf, ifd0, tiffStart, little, limit, visited),
    ...readThumbLocation(buf, ifd0, tiffStart, little, limit, payloadStart, segmentEnd, window, visited),
  };
}

/**
 * Reads one IFD's entries and next-IFD offset. `offsetRel`/`next` are
 * relative to `tiffStart`; each absolute IFD start is visited at most once
 * (cycle guard); at most `MAX_IFD_ENTRIES` entries are read.
 * @param {Buffer} buf @param {number} tiffStart @param {number} offsetRel
 * @param {boolean} little @param {number} limit Exclusive bound for any byte access.
 * @param {Set<number>} visited @returns {Ifd | null}
 */
function readIfd(buf, tiffStart, offsetRel, little, limit, visited) {
  if (!Number.isFinite(offsetRel) || offsetRel < 0) return null;
  const ifdStart = tiffStart + offsetRel;
  if (visited.has(ifdStart) || ifdStart + 2 > limit) return null;
  visited.add(ifdStart);
  const count = readU16(buf, ifdStart, little);
  /** @type {Ifd['entries']} */
  const entries = new Map();
  const used = Math.min(count, MAX_IFD_ENTRIES);
  for (let i = 0; i < used; i++) {
    const entryStart = ifdStart + 2 + i * 12;
    if (entryStart + 12 > limit) break;
    const tag = readU16(buf, entryStart, little);
    const type = readU16(buf, entryStart + 2, little);
    const count32 = readU32(buf, entryStart + 4, little);
    entries.set(tag, { type, count: count32, entryStart });
  }
  const nextPos = ifdStart + 2 + count * 12;
  const next = nextPos + 4 <= limit ? readU32(buf, nextPos, little) : 0;
  return { entries, next };
}

/** @param {Buffer} buf @param {number} pos @param {boolean} little */
function readU16(buf, pos, little) {
  return little ? buf.readUInt16LE(pos) : buf.readUInt16BE(pos);
}

/** @param {Buffer} buf @param {number} pos @param {boolean} little */
function readU32(buf, pos, little) {
  return little ? buf.readUInt32LE(pos) : buf.readUInt32BE(pos);
}

/** @param {number} type EXIF/TIFF tag type id. @returns {number} Bytes per value, 0 if unknown. */
function typeSize(type) {
  if (type === 1 || type === 2 || type === 6 || type === 7) return 1; // BYTE/ASCII/SBYTE/UNDEFINED
  if (type === 3 || type === 8) return 2; // SHORT/SSHORT
  if (type === 4 || type === 9 || type === 11 || type === 13) return 4; // LONG/SLONG/FLOAT/IFD
  if (type === 5 || type === 10 || type === 12) return 8; // RATIONAL/SRATIONAL/DOUBLE
  return 0;
}

/**
 * Raw value bytes of one IFD entry: inline in the 12-byte entry when they
 * fit in 4 bytes, else via its offset pointer; null if the type is unknown
 * or the bytes lie outside `limit`.
 * @param {Buffer} buf @param {number} tiffStart
 * @param {{ type: number, count: number, entryStart: number }} entry
 * @param {boolean} little @param {number} limit @returns {Buffer | null}
 */
function tagBytes(buf, tiffStart, entry, little, limit) {
  const size = typeSize(entry.type);
  const total = size * entry.count;
  if (size === 0 || total <= 0) return null;
  if (total <= 4) return buf.subarray(entry.entryStart + 8, entry.entryStart + 8 + total);
  const abs = tiffStart + readU32(buf, entry.entryStart + 8, little);
  return abs >= 0 && abs + total <= limit ? buf.subarray(abs, abs + total) : null;
}

/** A tag's SHORT value within `[min, max]`, or null if absent/out of range.
 * @param {Buffer} buf @param {Ifd} ifd @param {number} tag @param {number} tiffStart @param {boolean} little @param {number} limit @param {number} min @param {number} max @returns {number | null} */
function readShortTag(buf, ifd, tag, tiffStart, little, limit, min, max) {
  const entry = ifd.entries.get(tag);
  const bytes = entry && tagBytes(buf, tiffStart, entry, little, limit);
  if (!bytes || bytes.length < 2) return null;
  const value = little ? bytes.readUInt16LE(0) : bytes.readUInt16BE(0);
  return value >= min && value <= max ? value : null;
}

/** A tag's LONG value, or null if absent/unreadable.
 * @param {Buffer} buf @param {Ifd} ifd @param {number} tag @param {number} tiffStart @param {boolean} little @param {number} limit @returns {number | null} */
function readLongTag(buf, ifd, tag, tiffStart, little, limit) {
  const entry = ifd.entries.get(tag);
  const bytes = entry && tagBytes(buf, tiffStart, entry, little, limit);
  return bytes && bytes.length >= 4 ? (little ? bytes.readUInt32LE(0) : bytes.readUInt32BE(0)) : null;
}

/** A tag's NUL-terminated ASCII value, or null if absent/unreadable.
 * @param {Buffer} buf @param {Ifd} ifd @param {number} tag @param {number} tiffStart @param {boolean} little @param {number} limit @returns {string | null} */
function readAsciiTag(buf, ifd, tag, tiffStart, little, limit) {
  const entry = ifd.entries.get(tag);
  const bytes = entry && tagBytes(buf, tiffStart, entry, little, limit);
  return bytes ? bytes.toString('latin1').split('\0')[0] : null;
}

/**
 * DateTimeOriginal from the Exif sub-IFD (`0x8769`/`0x9003`), falling back to
 * IFD0's DateTime (`0x0132`) whenever DateTimeOriginal yields no valid date —
 * absent, unreadable or invalid (e.g. `0000:00:00 00:00:00`).
 * @param {Buffer} buf @param {Ifd} ifd0 @param {number} tiffStart @param {boolean} little @param {number} limit @param {Set<number>} visited @returns {string | null}
 */
function readTakenAt(buf, ifd0, tiffStart, little, limit, visited) {
  const exifIfdOffset = readLongTag(buf, ifd0, 0x8769, tiffStart, little, limit);
  const exifIfd = exifIfdOffset === null ? null : readIfd(buf, tiffStart, exifIfdOffset, little, limit, visited);
  const original = exifIfd ? readAsciiTag(buf, exifIfd, 0x9003, tiffStart, little, limit) : null;
  const fromOriginal = original === null ? null : formatTakenAt(original);
  if (fromOriginal !== null) return fromOriginal;
  const fallback = readAsciiTag(buf, ifd0, 0x0132, tiffStart, little, limit);
  return fallback === null ? null : formatTakenAt(fallback);
}

/**
 * Validates and reformats an EXIF date string's first 19 characters
 * (`YYYY:MM:DD HH:MM:SS`) as `YYYY-MM-DDTHH:MM:SS`, or null if invalid.
 *
 * @param {string} raw
 * @returns {string | null}
 */
function formatTakenAt(raw) {
  const m = DATE_RE.exec(raw.slice(0, 19));
  if (!m) return null;
  const [, year, month, day, hour, minute, second] = m.map(Number);
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

/**
 * Reads IFD1 (IFD0's next-IFD) and accepts its thumbnail only when
 * Compression is absent or a readable 6, `0 < length <= 65535`, its range lies inside
 * the APP1 segment's declared length, and — when its first two bytes lie
 * inside `window` — they are the JPEG SOI marker.
 * @param {Buffer} buf @param {Ifd} ifd0 @param {number} tiffStart @param {boolean} little
 * @param {number} limit @param {number} payloadStart @param {number} segmentEnd @param {number} window @param {Set<number>} visited
 * @returns {{ thumbOffset: number | null, thumbLength: number | null }}
 */
function readThumbLocation(buf, ifd0, tiffStart, little, limit, payloadStart, segmentEnd, window, visited) {
  /** @type {{ thumbOffset: number | null, thumbLength: number | null }} */
  const none = { thumbOffset: null, thumbLength: null };
  if (!ifd0.next) return none;
  const ifd1 = readIfd(buf, tiffStart, ifd0.next, little, limit, visited);
  if (!ifd1) return none;
  if (ifd1.entries.has(0x0103) && readShortTag(buf, ifd1, 0x0103, tiffStart, little, limit, 6, 6) === null) return none;
  const offsetRel = readLongTag(buf, ifd1, 0x0201, tiffStart, little, limit);
  const length = readLongTag(buf, ifd1, 0x0202, tiffStart, little, limit);
  if (offsetRel === null || length === null || length <= 0 || length > MAX_THUMB_LENGTH) return none;
  const absOffset = tiffStart + offsetRel;
  if (absOffset < payloadStart || absOffset + length > segmentEnd) return none;
  const peekEnd = Math.min(segmentEnd, window);
  if (absOffset + 2 <= peekEnd && !isJpegStart(buf.subarray(absOffset, absOffset + 2))) return none;
  return { thumbOffset: absOffset, thumbLength: length };
}
