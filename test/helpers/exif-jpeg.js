// @ts-check

/**
 * Test-only synthetic EXIF-JPEG builder: a tiny base JPEG embedded as base64
 * (generated once offline, never at runtime), an EXIF APP1 wrapper covering
 * both byte orders, thumbnails, orientation, dates and malformed variants
 * for `test/library/tags/exif.test.js`, and the CLI that (re)writes the
 * committed QA fixture tree and a large synthetic folder.
 *
 * @see docs/specs/spec-image-gallery.md — "Fixtures", "QA fixture tree".
 */

import { writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 16x16 baseline grayscale JPEG, flat 8x8 blocks (top row dark, bottom row
// light), so orientation is visible as an asymmetric marker band.
const BASE_JPEG_B64 =
  '/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/wAALCAAQABABAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAAPwDkw9YD/9k=';

/** @returns {Buffer} A fresh copy of the tiny base JPEG (SOI..EOI, no EXIF). */
export function baseJpegBuffer() {
  return Buffer.from(BASE_JPEG_B64, 'base64');
}

const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;

/** @param {number} value @param {2 | 4} size @param {boolean} little */
function u(value, size, little) {
  const buf = Buffer.alloc(size);
  if (size === 2) little ? buf.writeUInt16LE(value, 0) : buf.writeUInt16BE(value, 0);
  else little ? buf.writeUInt32LE(value, 0) : buf.writeUInt32BE(value, 0);
  return buf;
}

/** Left-justifies an inline value in a 4-byte TIFF entry field (SHORT: first 2 bytes; LONG: all 4).
 * @param {number} type @param {number} value @param {boolean} little @returns {Buffer} */
function inlineValue(type, value, little) {
  const buf = Buffer.alloc(4);
  if (type === TYPE_SHORT) little ? buf.writeUInt16LE(value, 0) : buf.writeUInt16BE(value, 0);
  else little ? buf.writeUInt32LE(value, 0) : buf.writeUInt32BE(value, 0);
  return buf;
}

/** @param {string} value @returns {Buffer} NUL-terminated ASCII bytes. */
function dateBytes(value) {
  return Buffer.from(`${value}\0`, 'latin1');
}

/**
 * Assembles one IFD: 2-byte count + 12-byte entries + 4-byte next offset.
 * @param {{ tag: number, type: number, count: number, valueRel?: number, valueInline?: number }[]} entries
 * @param {number} next @param {boolean} little
 */
function buildIfd(entries, next, little) {
  const body = entries.map((e) => {
    const value = e.valueRel !== undefined ? u(e.valueRel, 4, little) : inlineValue(e.type, e.valueInline ?? 0, little);
    return Buffer.concat([u(e.tag, 2, little), u(e.type, 2, little), u(e.count, 4, little), value]);
  });
  return Buffer.concat([u(entries.length, 2, little), ...body, u(next, 4, little)]);
}

/**
 * Builds a JPEG buffer (SOI + APP1/EXIF + the rest of a base image) covering
 * both byte orders, orientation, dates, an IFD1 thumbnail and malformed
 * variants (out-of-range/oversized/misplaced thumbnail, IFD self-loops for
 * the cycle guard, an out-of-window ExifIFD pointer).
 *
 * @param {object} [opts]
 * @param {'II' | 'MM'} [opts.order]
 * @param {number} [opts.orientation] Omit to leave the tag out.
 * @param {string} [opts.dateTimeOriginal] Exif sub-IFD DateTimeOriginal.
 * @param {string} [opts.dateTime] IFD0 DateTime (fallback).
 * @param {{ data?: Buffer, compression?: number, offsetRel?: number, length?: number } | null} [opts.thumbnail]
 * @param {boolean} [opts.exifIfdSelfLoop] ExifIFD offset points back at IFD0.
 * @param {number} [opts.exifIfdOffsetOverrideRel] Forces the ExifIFD pointer.
 * @param {boolean} [opts.ifd1SelfLoop] IFD0's next-IFD offset points back at IFD0.
 * @param {Buffer} [opts.base] Base JPEG to wrap (default {@link baseJpegBuffer}).
 * @returns {Buffer}
 */
export function buildExifJpeg(opts = {}) {
  const {
    order = 'II', orientation, dateTimeOriginal, dateTime, thumbnail = null,
    exifIfdSelfLoop = false, exifIfdOffsetOverrideRel, ifd1SelfLoop = false, base = baseJpegBuffer(),
  } = opts;
  const little = order === 'II';
  const wantExifIfd = dateTimeOriginal !== undefined || exifIfdOffsetOverrideRel !== undefined || exifIfdSelfLoop;

  let pos = 8; // TIFF header size
  const ifd0Rel = pos;
  const n0 = (orientation !== undefined ? 1 : 0) + (wantExifIfd ? 1 : 0) + (dateTime !== undefined ? 1 : 0);
  pos += 2 + n0 * 12 + 4;
  /** @type {number | undefined} */
  let dateTimeRel;
  if (dateTime !== undefined) { dateTimeRel = pos; pos += dateBytes(dateTime).length; }
  /** @type {number | undefined} */
  let exifIfdRel;
  /** @type {number | undefined} */
  let dtoRel;
  if (wantExifIfd) {
    exifIfdRel = pos;
    pos += 2 + (dateTimeOriginal !== undefined ? 12 : 0) + 4;
    if (dateTimeOriginal !== undefined) { dtoRel = pos; pos += dateBytes(dateTimeOriginal).length; }
  }
  let ifd1Rel = 0;
  let thumbDataRel = 0;
  if (thumbnail) {
    ifd1Rel = pos;
    pos += 2 + ((thumbnail.compression !== undefined ? 1 : 0) + 2) * 12 + 4;
    thumbDataRel = pos;
    pos += (thumbnail.data ?? baseJpegBuffer()).length;
  }

  /** @type {{ tag: number, type: number, count: number, valueRel?: number, valueInline?: number }[]} */
  const ifd0Entries = [];
  if (orientation !== undefined) ifd0Entries.push({ tag: 0x0112, type: TYPE_SHORT, count: 1, valueInline: orientation });
  if (wantExifIfd) {
    const exifIfdValueRel = exifIfdOffsetOverrideRel ?? (exifIfdSelfLoop ? ifd0Rel : exifIfdRel ?? 0);
    ifd0Entries.push({ tag: 0x8769, type: TYPE_LONG, count: 1, valueRel: exifIfdValueRel });
  }
  if (dateTime !== undefined) ifd0Entries.push({ tag: 0x0132, type: TYPE_ASCII, count: dateBytes(dateTime).length, valueRel: dateTimeRel ?? 0 });
  /** @type {Buffer[]} */
  const parts = [buildIfd(ifd0Entries, ifd1SelfLoop ? ifd0Rel : thumbnail ? ifd1Rel : 0, little)];
  if (dateTime !== undefined) parts.push(dateBytes(dateTime));
  if (wantExifIfd) {
    const exifEntries = dateTimeOriginal !== undefined
      ? [{ tag: 0x9003, type: TYPE_ASCII, count: dateBytes(dateTimeOriginal).length, valueRel: dtoRel ?? 0 }]
      : [];
    parts.push(buildIfd(exifEntries, 0, little));
    if (dateTimeOriginal !== undefined) parts.push(dateBytes(dateTimeOriginal));
  }
  if (thumbnail) {
    const thumbData = thumbnail.data ?? baseJpegBuffer();
    /** @type {{ tag: number, type: number, count: number, valueRel?: number, valueInline?: number }[]} */
    const ifd1Entries = [];
    if (thumbnail.compression !== undefined) ifd1Entries.push({ tag: 0x0103, type: TYPE_SHORT, count: 1, valueInline: thumbnail.compression });
    ifd1Entries.push({ tag: 0x0201, type: TYPE_LONG, count: 1, valueRel: thumbnail.offsetRel ?? thumbDataRel });
    ifd1Entries.push({ tag: 0x0202, type: TYPE_LONG, count: 1, valueInline: thumbnail.length ?? thumbData.length });
    parts.push(buildIfd(ifd1Entries, 0, little), thumbData);
  }

  const tiff = Buffer.concat([Buffer.from(order, 'ascii'), u(42, 2, little), u(ifd0Rel, 4, little), ...parts]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u(2 + payload.length, 2, false), payload]);
  return Buffer.concat([base.subarray(0, 2), app1, base.subarray(2)]);
}

/** QA fixture tree per the spec's "QA fixture tree" row; non-JPEG entries are a few synthetic bytes.
 * @type {{ p: string, exif?: Parameters<typeof buildExifJpeg>[0], raw?: Buffer, mtime: string }[]} */
const QA_FILES = [
  { p: 'Bilder/Urlaub 2024/Italien/IMG_0412.jpg', exif: { order: 'II', orientation: 1, dateTimeOriginal: '2024:07:14 09:14:00', thumbnail: { compression: 6 } }, mtime: '2024-07-14T09:14:00' },
  { p: 'Bilder/Urlaub 2024/Italien/IMG_0415.jpg', exif: { order: 'MM', orientation: 6, dateTimeOriginal: '2024:07:14 10:28:00', thumbnail: { compression: 6 } }, mtime: '2024-07-14T10:28:00' },
  { p: 'Bilder/Urlaub 2024/Italien/IMG_0419.jpg', exif: { orientation: 8, dateTimeOriginal: '2024:07:14 11:45:00', thumbnail: { compression: 6 } }, mtime: '2024-07-14T11:45:00' },
  { p: 'Bilder/Urlaub 2024/Italien/IMG_0424.jpg', raw: baseJpegBuffer(), mtime: '2024-07-14T12:00:00' },
  { p: 'Bilder/Urlaub 2024/Italien/IMG_0431.heic', raw: Buffer.from('synthetic-heic-fixture'), mtime: '2024-07-14T12:05:00' },
  { p: 'Bilder/Urlaub 2024/Italien/VID_0433.webm', raw: Buffer.from('synthetic-webm-fixture'), mtime: '2024-07-14T12:10:00' },
  { p: 'Bilder/Urlaub 2024/Italien/VID_0434.mov', raw: Buffer.from('synthetic-mov-fixture'), mtime: '2024-07-14T12:15:00' },
  { p: 'Bilder/Urlaub 2024/Italien/Screenshot 2.png', raw: Buffer.from('synthetic-png-fixture-2'), mtime: '2024-07-15T08:00:00' },
  { p: 'Bilder/Urlaub 2024/Italien/Screenshot 10.png', raw: Buffer.from('synthetic-png-fixture-10'), mtime: '2024-07-15T08:01:00' },
  { p: 'Bilder/Urlaub 2024/Italien/Tag 1 – Rom/IMG_0501.jpg', exif: { orientation: 1, dateTimeOriginal: '2024:07:15 09:00:00', thumbnail: { compression: 6 } }, mtime: '2024-07-15T09:00:00' },
  { p: 'Bilder/Urlaub 2024/Italien/Tag 2 – Florenz/IMG_0601.jpg', exif: { orientation: 1, dateTimeOriginal: '2024:07:16 09:00:00', thumbnail: { compression: 6 } }, mtime: '2024-07-16T09:00:00' },
  { p: 'Bilder/Familie/geburtstag.jpg', exif: { dateTime: '2023:05:01 15:00:00' }, mtime: '2023-05-01T15:00:00' },
  { p: 'Bilder/root.gif', raw: Buffer.from('synthetic-gif-fixture'), mtime: '2022-01-01T00:00:00' },
  { p: 'Bilder/.versteckt.jpg', raw: baseJpegBuffer(), mtime: '2022-01-01T00:00:00' },
  { p: 'Bilder/@eaDir/x.jpg', raw: baseJpegBuffer(), mtime: '2022-01-01T00:00:00' },
  { p: 'Photos/Familie/alias.jpg', exif: { dateTime: '2023:05:02 10:00:00' }, mtime: '2023-05-02T10:00:00' },
];

/** (Re)writes the committed QA fixture tree under `root`, with fixed mtimes.
 * @param {string} root */
function writeQaTree(root) {
  for (const f of QA_FILES) {
    const full = path.join(root, f.p);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, f.exif ? buildExifJpeg(f.exif) : f.raw ?? Buffer.alloc(0));
    const t = new Date(f.mtime);
    utimesSync(full, t, t);
  }
  console.log(`wrote ${QA_FILES.length} QA fixture files under ${root}`);
}

/** Writes `n` copies of the base JPEG into `dir`, for the large-folder check.
 * @param {number} n @param {string} dir */
function writeBulk(n, dir) {
  mkdirSync(dir, { recursive: true });
  const data = baseJpegBuffer();
  for (let i = 1; i <= n; i++) writeFileSync(path.join(dir, `bulk_${String(i).padStart(5, '0')}.jpg`), data);
  console.log(`wrote ${n} bulk files under ${dir}`);
}

function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === '--write') writeQaTree(path.resolve('test/fixtures/media'));
  else if (cmd === '--bulk' && a && b) writeBulk(Number(a), b);
  else {
    process.stderr.write('Usage: node test/helpers/exif-jpeg.js --write | --bulk <n> <dir>\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
