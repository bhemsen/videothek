/**
 * Pure FLAC metadata reader: STREAMINFO duration, VORBIS_COMMENT fields and a
 * PICTURE reference, within a bounded read budget. Never opens a file itself
 * (the caller supplies `readAt`) and never throws on malformed input.
 *
 * @see docs/specs/spec-music-audiobooks.md — "Fields read", "Read budget",
 * "Duration without decoding", "Reader interfaces".
 */

/** @typedef {{ offset: number, length: number, mime: string }} PictureRef */

const READ_BUDGET = 256 * 1024;
const VORBIS_COMMENT_MAX = 64 * 1024;
const PICTURE_READ_CAP = 4 * 1024;
const PICTURE_MAX_LENGTH = 10 * 1024 * 1024;
const PICTURE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Reads STREAMINFO duration, VORBIS_COMMENT fields and a PICTURE reference
 * from a FLAC stream, skipping a leading ID3v2 tag if present.
 *
 * @param {(position: number, length: number) => Promise<Buffer>} readAt
 *   Reads at most `length` bytes at `position`; returns a shorter buffer at EOF.
 * @param {number} fileSize Total file size in bytes.
 * @returns {Promise<{ fields: Record<string, string>, picture: PictureRef | null, durationMs: number | null } | null>}
 */
export async function readFlac(readAt, fileSize) {
  let budget = READ_BUDGET;
  const head = await readAt(0, 10);
  budget -= head.length;
  let pos = leadingId3v2Size(head);

  const marker = await readAt(pos, 4);
  budget -= marker.length;
  if (marker.length < 4 || marker.toString('ascii', 0, 4) !== 'fLaC') return null;
  pos += 4;

  return readMetadataBlocks(readAt, pos, fileSize, budget);
}

/**
 * @param {Buffer} head First bytes of the file.
 * @returns {number} Byte offset right after a leading ID3v2 tag, else 0.
 */
function leadingId3v2Size(head) {
  if (head.length < 10) return 0;
  const isId3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
  if (!isId3 || head[3] < 2 || head[3] > 4) return 0;
  const size =
    ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
  const hasFooter = head[3] === 4 && (head[5] & 0x10) !== 0; // ID3v2.4 footer flag adds 10 bytes
  return 10 + size + (hasFooter ? 10 : 0);
}

/**
 * Walks metadata blocks from `pos` until the last-block flag, EOF or budget
 * exhaustion, collecting Vorbis fields, a picture reference and duration.
 *
 * @param {(position: number, length: number) => Promise<Buffer>} readAt
 * @param {number} pos Offset right after the "fLaC" marker.
 * @param {number} fileSize
 * @param {number} budget Bytes left in the read budget.
 * @returns {Promise<{ fields: Record<string, string>, picture: PictureRef | null, durationMs: number | null }>}
 */
async function readMetadataBlocks(readAt, pos, fileSize, budget) {
  const fields = Object.create(null);
  let frontPicture = null;
  let firstPicture = null;
  let streamInfo = null;
  let last = false;

  while (!last && budget > 0 && pos + 4 <= fileSize) {
    const header = await readAt(pos, 4);
    budget -= header.length;
    if (header.length < 4) break;
    last = (header[0] & 0x80) !== 0;
    const type = header[0] & 0x7f;
    const length = (header[1] << 16) | (header[2] << 8) | header[3];
    const blockStart = pos + 4;

    if (type === 0) {
      const buf = await readAt(blockStart, Math.min(length, 34, Math.max(budget, 0)));
      budget -= buf.length;
      streamInfo = streamInfo ?? parseStreamInfo(buf);
    } else if (type === 4 && length <= VORBIS_COMMENT_MAX) {
      const buf = await readAt(blockStart, Math.min(length, Math.max(budget, 0)));
      budget -= buf.length;
      mergeMissing(fields, parseVorbisComments(buf));
    } else if (type === 6) {
      const buf = await readAt(blockStart, Math.min(length, PICTURE_READ_CAP, Math.max(budget, 0)));
      budget -= buf.length;
      const picture = parsePicture(buf, blockStart, length);
      if (picture?.pictureType === 3) frontPicture = frontPicture ?? picture;
      else if (picture) firstPicture = firstPicture ?? picture;
    }
    pos = blockStart + length;
  }

  const chosen = frontPicture ?? firstPicture;
  return {
    fields,
    picture: chosen ? { offset: chosen.offset, length: chosen.length, mime: chosen.mime } : null,
    durationMs: durationFromStreamInfo(streamInfo),
  };
}

/**
 * @param {{ sampleRate: number, totalSamples: number } | null} streamInfo
 * @returns {number | null}
 */
function durationFromStreamInfo(streamInfo) {
  if (!streamInfo || !streamInfo.sampleRate || !streamInfo.totalSamples) return null;
  return Math.round((streamInfo.totalSamples / streamInfo.sampleRate) * 1000);
}

/**
 * Parses the sample rate and total sample count out of a STREAMINFO block.
 *
 * @param {Buffer} buf STREAMINFO block content (up to 34 bytes).
 * @returns {{ sampleRate: number, totalSamples: number } | null}
 */
function parseStreamInfo(buf) {
  if (buf.length < 18) return null;
  const hi = BigInt(buf.readUInt32BE(10));
  const lo = BigInt(buf.readUInt32BE(14));
  const packed = (hi << 32n) | lo;
  const sampleRate = Number((packed >> 44n) & 0xfffffn);
  const totalSamples = Number(packed & 0xfffffffffn);
  return { sampleRate, totalSamples };
}

/**
 * Parses a VORBIS_COMMENT block body into fields keyed by upper-cased Vorbis
 * key. Repeated keys keep their first value; empty values are dropped.
 *
 * @param {Buffer} buf VORBIS_COMMENT block content.
 * @returns {Record<string, string>}
 */
function parseVorbisComments(buf) {
  const fields = Object.create(null);
  if (buf.length < 4) return fields;
  const vendorLen = buf.readUInt32LE(0);
  let offset = 4 + vendorLen;
  if (offset + 4 > buf.length) return fields;
  const count = buf.readUInt32LE(offset);
  offset += 4;

  for (let i = 0; i < count && offset + 4 <= buf.length; i++) {
    const len = buf.readUInt32LE(offset);
    offset += 4;
    if (offset + len > buf.length) break;
    const raw = buf.toString('utf8', offset, offset + len);
    offset += len;
    addVorbisEntry(fields, raw);
  }
  return fields;
}

/**
 * Copies entries from `source` into `target` for keys `target` does not
 * already have, so a repeated VORBIS_COMMENT block (malformed file) cannot
 * overwrite a value the first block already set.
 *
 * @param {Record<string, string>} target
 * @param {Record<string, string>} source
 */
function mergeMissing(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (!Object.hasOwn(target, key)) target[key] = value;
  }
}

/**
 * @param {Record<string, string>} fields
 * @param {string} raw One "KEY=value" comment entry.
 */
function addVorbisEntry(fields, raw) {
  const eq = raw.indexOf('=');
  if (eq <= 0) return;
  const key = raw.slice(0, eq).toUpperCase();
  const value = raw.slice(eq + 1).split('\0')[0].trim();
  if (value === '' || Object.hasOwn(fields, key)) return;
  fields[key] = value;
}

/**
 * Parses a PICTURE block's header fields to locate its image bytes without
 * reading them. Only the first `PICTURE_READ_CAP` bytes are available.
 *
 * @param {Buffer} buf Up to `PICTURE_READ_CAP` bytes from the block start.
 * @param {number} blockStartAbs Absolute file offset of the block content.
 * @param {number} blockLength Declared byte length of the block content, from
 *   the metadata block header — bounds `dataLength` so a corrupt value cannot
 *   reference bytes past this block (into the next block or past EOF).
 * @returns {(PictureRef & { pictureType: number }) | null}
 */
function parsePicture(buf, blockStartAbs, blockLength) {
  if (buf.length < 8) return null;
  const pictureType = buf.readUInt32BE(0);
  const mimeLen = buf.readUInt32BE(4);
  let offset = 8;
  if (offset + mimeLen + 4 > buf.length) return null;
  let mime = buf.toString('ascii', offset, offset + mimeLen).replace(/\0+$/, '').trim().toLowerCase();
  offset += mimeLen;

  const descLen = buf.readUInt32BE(offset);
  offset += 4 + descLen + 16; // description + width/height/depth/colors
  if (offset + 4 > buf.length) return null;
  const dataLength = buf.readUInt32BE(offset);
  const dataStart = offset + 4;

  if (mime === 'image/jpg') mime = 'image/jpeg';
  if (!PICTURE_MIME_TYPES.has(mime)) return null;
  if (dataLength <= 0 || dataLength > PICTURE_MAX_LENGTH) return null;
  if (dataStart + dataLength > blockLength) return null;
  return { offset: blockStartAbs + dataStart, length: dataLength, mime, pictureType };
}
