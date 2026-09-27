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

import { writeFileSync, mkdirSync, utimesSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

// 16x16 baseline grayscale JPEG, flat 8x8 blocks (top row dark, bottom row
// light), so orientation is visible as an asymmetric marker band.
const BASE_JPEG_B64 =
  '/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/wAALCAAQABABAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAAPwDkw9YD/9k=';

// Same 16x16 flat-8x8-block JPEG, but with the dark/light blocks re-arranged
// so the marker band sits on the LEFT before any orientation rotation is
// applied. Orientation 6 is displayed with CSS `rotate(90deg)` (clockwise),
// which moves a raw left edge to the displayed top — so the tile/lightbox
// show the band at the top per the spec's Human QA step. Same header bytes
// (DQT/SOF0/DHT/SOS) as `BASE_JPEG_B64`, only the DC-only entropy data
// differs (which of the four flat blocks are dark vs. light).
const LEFT_BAND_JPEG_B64 =
  '/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/wAALCAAQABABAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAAPwDk3rDyd6w//9k=';

// Mirror of the above with the band on the RIGHT, for orientation-8 fixtures:
// orientation 8 is displayed with `rotate(270deg)` (90° counter-clockwise),
// which moves a raw right edge to the displayed top.
const RIGHT_BAND_JPEG_B64 =
  '/9j/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/wAALCAAQABABAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAAPwDrHk71h5O//9k=';

/** @returns {Buffer} A fresh copy of the tiny base JPEG (SOI..EOI, no EXIF). */
export function baseJpegBuffer() {
  return Buffer.from(BASE_JPEG_B64, 'base64');
}

/** @returns {Buffer} Base JPEG with the marker band on the LEFT (pre-rotation) — orientation-6 fixtures. */
export function leftBandJpegBuffer() {
  return Buffer.from(LEFT_BAND_JPEG_B64, 'base64');
}

/** @returns {Buffer} Base JPEG with the marker band on the RIGHT (pre-rotation) — orientation-8 fixtures. */
export function rightBandJpegBuffer() {
  return Buffer.from(RIGHT_BAND_JPEG_B64, 'base64');
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

/** @typedef {{ tag: number, type: number, count: number, valueRel?: number, valueInline?: number }} IfdEntry */

/**
 * @typedef {object} ExifJpegOptions
 * @property {'II' | 'MM'} [order]
 * @property {number} [orientation] Omit to leave the tag out.
 * @property {string} [dateTimeOriginal] Exif sub-IFD DateTimeOriginal.
 * @property {string} [dateTime] IFD0 DateTime (fallback).
 * @property {{ data?: Buffer, compression?: number, compressionType?: number, offsetRel?: number, length?: number } | null} [thumbnail]
 *   IFD1 thumbnail; `compressionType` overrides the Compression entry's TIFF type (default SHORT).
 * @property {boolean} [exifIfdSelfLoop] ExifIFD offset points back at IFD0.
 * @property {number} [exifIfdOffsetOverrideRel] Forces the ExifIFD pointer.
 * @property {boolean} [ifd1SelfLoop] IFD0's next-IFD offset points back at IFD0.
 * @property {number} [ifd1OffsetOverrideRel] Forces IFD0's next-IFD offset.
 * @property {number} [ifd0OffsetOverrideRel] Forces the TIFF header's IFD0 offset.
 * @property {Buffer} [base] Base JPEG to wrap (default {@link baseJpegBuffer}).
 */

/**
 * Offsets (relative to the TIFF header) of the structures `buildExifJpeg`
 * writes, in file order: IFD0, its DateTime string, the Exif sub-IFD, its
 * DateTimeOriginal string, IFD1 and the thumbnail data.
 * @param {ExifJpegOptions} o @param {boolean} wantExifIfd
 */
function layoutTiff(o, wantExifIfd) {
  const layout = { ifd0Rel: 8, dateTimeRel: 0, exifIfdRel: 0, dtoRel: 0, ifd1Rel: 0, thumbDataRel: 0 };
  const n0 = (o.orientation !== undefined ? 1 : 0) + (wantExifIfd ? 1 : 0) + (o.dateTime !== undefined ? 1 : 0);
  let pos = layout.ifd0Rel + 2 + n0 * 12 + 4;
  if (o.dateTime !== undefined) { layout.dateTimeRel = pos; pos += dateBytes(o.dateTime).length; }
  if (wantExifIfd) {
    layout.exifIfdRel = pos;
    pos += 2 + (o.dateTimeOriginal !== undefined ? 12 : 0) + 4;
    if (o.dateTimeOriginal !== undefined) { layout.dtoRel = pos; pos += dateBytes(o.dateTimeOriginal).length; }
  }
  if (o.thumbnail) {
    layout.ifd1Rel = pos;
    layout.thumbDataRel = pos + 2 + ((o.thumbnail.compression !== undefined ? 1 : 0) + 2) * 12 + 4;
  }
  return layout;
}

/** IFD0 (orientation, ExifIFD pointer, DateTime) plus its next-IFD offset.
 * @param {ExifJpegOptions} o @param {ReturnType<typeof layoutTiff>} layout @param {boolean} wantExifIfd @param {boolean} little */
function buildIfd0(o, layout, wantExifIfd, little) {
  /** @type {IfdEntry[]} */
  const entries = [];
  if (o.orientation !== undefined) entries.push({ tag: 0x0112, type: TYPE_SHORT, count: 1, valueInline: o.orientation });
  if (wantExifIfd) {
    const exifIfdValueRel = o.exifIfdOffsetOverrideRel ?? (o.exifIfdSelfLoop ? layout.ifd0Rel : layout.exifIfdRel);
    entries.push({ tag: 0x8769, type: TYPE_LONG, count: 1, valueRel: exifIfdValueRel });
  }
  if (o.dateTime !== undefined) entries.push({ tag: 0x0132, type: TYPE_ASCII, count: dateBytes(o.dateTime).length, valueRel: layout.dateTimeRel });
  const next = o.ifd1OffsetOverrideRel ?? (o.ifd1SelfLoop ? layout.ifd0Rel : o.thumbnail ? layout.ifd1Rel : 0);
  return buildIfd(entries, next, little);
}

/** IFD1 (Compression, thumbnail offset/length) followed by the thumbnail bytes.
 * @param {NonNullable<ExifJpegOptions['thumbnail']>} thumbnail @param {number} thumbDataRel @param {boolean} little */
function buildThumbIfd(thumbnail, thumbDataRel, little) {
  const data = thumbnail.data ?? baseJpegBuffer();
  /** @type {IfdEntry[]} */
  const entries = [];
  if (thumbnail.compression !== undefined) {
    entries.push({ tag: 0x0103, type: thumbnail.compressionType ?? TYPE_SHORT, count: 1, valueInline: thumbnail.compression });
  }
  entries.push({ tag: 0x0201, type: TYPE_LONG, count: 1, valueRel: thumbnail.offsetRel ?? thumbDataRel });
  entries.push({ tag: 0x0202, type: TYPE_LONG, count: 1, valueInline: thumbnail.length ?? data.length });
  return Buffer.concat([buildIfd(entries, 0, little), data]);
}

/**
 * Builds a JPEG buffer (SOI + APP1/EXIF + the rest of a base image) covering
 * both byte orders, orientation, dates, an IFD1 thumbnail and malformed
 * variants (out-of-range/oversized/misplaced thumbnail, IFD self-loops for
 * the cycle guard, out-of-window IFD pointers).
 *
 * @param {ExifJpegOptions} [opts]
 * @returns {Buffer}
 */
export function buildExifJpeg(opts = {}) {
  const { order = 'II', dateTimeOriginal, dateTime, thumbnail = null, base = baseJpegBuffer() } = opts;
  const little = order === 'II';
  const wantExifIfd = dateTimeOriginal !== undefined || opts.exifIfdOffsetOverrideRel !== undefined || Boolean(opts.exifIfdSelfLoop);
  const layout = layoutTiff(opts, wantExifIfd);
  /** @type {Buffer[]} */
  const parts = [buildIfd0(opts, layout, wantExifIfd, little)];
  if (dateTime !== undefined) parts.push(dateBytes(dateTime));
  if (wantExifIfd) {
    const exifEntries = dateTimeOriginal !== undefined
      ? [{ tag: 0x9003, type: TYPE_ASCII, count: dateBytes(dateTimeOriginal).length, valueRel: layout.dtoRel }]
      : [];
    parts.push(buildIfd(exifEntries, 0, little));
    if (dateTimeOriginal !== undefined) parts.push(dateBytes(dateTimeOriginal));
  }
  if (thumbnail) parts.push(buildThumbIfd(thumbnail, layout.thumbDataRel, little));
  const ifd0Pointer = opts.ifd0OffsetOverrideRel ?? layout.ifd0Rel;
  const tiff = Buffer.concat([Buffer.from(order, 'ascii'), u(42, 2, little), u(ifd0Pointer, 4, little), ...parts]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), u(2 + payload.length, 2, false), payload]);
  return Buffer.concat([base.subarray(0, 2), app1, base.subarray(2)]);
}

/** QA fixture tree per the spec's "QA fixture tree" row; non-JPEG entries are a few synthetic
 * bytes, except `VID_0433.webm` (`skipContent`): the Fixtures row makes it the one file that must
 * be a real, decodable video, committed separately by the docs/fixtures issue, so this writer
 * never fabricates or overwrites it — it only re-applies the fixed mtime when the file already
 * exists and otherwise leaves it out.
 * @type {{ p: string, exif?: Parameters<typeof buildExifJpeg>[0], raw?: Buffer, skipContent?: boolean, mtime: string }[]} */
const QA_FILES = [
  { p: 'Bilder/Urlaub 2024/Italien/IMG_0412.jpg', exif: { order: 'II', orientation: 1, dateTimeOriginal: '2024:07:14 09:14:00', thumbnail: { compression: 6 } }, mtime: '2024-07-14T09:14:00' },
  { p: 'Bilder/Urlaub 2024/Italien/IMG_0415.jpg', exif: { order: 'MM', orientation: 6, dateTimeOriginal: '2024:07:14 10:28:00', base: leftBandJpegBuffer(), thumbnail: { compression: 6, data: leftBandJpegBuffer() } }, mtime: '2024-07-14T10:28:00' },
  { p: 'Bilder/Urlaub 2024/Italien/IMG_0419.jpg', exif: { orientation: 8, dateTimeOriginal: '2024:07:14 11:45:00', base: rightBandJpegBuffer(), thumbnail: { compression: 6, data: rightBandJpegBuffer() } }, mtime: '2024-07-14T11:45:00' },
  { p: 'Bilder/Urlaub 2024/Italien/IMG_0424.jpg', raw: baseJpegBuffer(), mtime: '2024-07-14T12:00:00' },
  { p: 'Bilder/Urlaub 2024/Italien/IMG_0431.heic', raw: Buffer.from('synthetic-heic-fixture'), mtime: '2024-07-14T12:05:00' },
  { p: 'Bilder/Urlaub 2024/Italien/VID_0433.webm', skipContent: true, mtime: '2024-07-14T12:10:00' },
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
  let written = 0;
  for (const f of QA_FILES) {
    const full = path.join(root, f.p);
    if (f.skipContent) {
      if (existsSync(full)) utimesSync(full, new Date(f.mtime), new Date(f.mtime));
      continue;
    }
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, f.exif ? buildExifJpeg(f.exif) : f.raw ?? Buffer.alloc(0));
    const t = new Date(f.mtime);
    utimesSync(full, t, t);
    written += 1;
  }
  process.stdout.write(`wrote ${written} QA fixture files under ${root}\n`);
}

/** Writes `n` copies of the base JPEG into `dir`, for the large-folder check.
 * @param {number} n @param {string} dir */
function writeBulk(n, dir) {
  mkdirSync(dir, { recursive: true });
  const data = baseJpegBuffer();
  for (let i = 1; i <= n; i++) writeFileSync(path.join(dir, `bulk_${String(i).padStart(5, '0')}.jpg`), data);
  process.stdout.write(`wrote ${n} bulk files under ${dir}\n`);
}

const FIXTURES_MEDIA_DIR = new URL('../fixtures/media/', import.meta.url);

function main() {
  const [cmd, a, b] = process.argv.slice(2);
  const n = Number(a);
  if (cmd === '--write') writeQaTree(fileURLToPath(FIXTURES_MEDIA_DIR));
  else if (cmd === '--bulk' && b && Number.isInteger(n) && n > 0) writeBulk(n, b);
  else {
    process.stderr.write('Usage: node test/helpers/exif-jpeg.js --write | --bulk <n> <dir>\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
