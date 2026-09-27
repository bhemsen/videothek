// @ts-check
// Test-only builder for synthetic ID3v2.3/2.4 tags and silent MPEG-1 Layer
// III CBR frames (with optional Xing/VBRI headers), plus small readAt
// helpers shared by the tag-reader test suites. Never used by src/.

/** @typedef {import('../../src/library/tags/id3v2.js').ReadAt} ReadAt */

export const ENCODING = { LATIN1: 0, UTF16_BOM: 1, UTF16_BE: 2, UTF8: 3 };

/** Buffer-backed `readAt`: clamps out-of-range/negative input, short at EOF, never throws.
 * @param {Buffer} buffer @returns {ReadAt} */
export function makeReadAt(buffer) {
  return async (position, length) => {
    const start = Math.max(0, Math.min(position, buffer.length));
    const end = Math.max(start, Math.min(start + Math.max(0, length), buffer.length));
    return buffer.subarray(start, end);
  };
}

/** Wraps a `readAt` to count total bytes ever returned, for read-budget assertions.
 * @param {ReadAt} readAt @returns {{ readAt: ReadAt, bytesRead: () => number }} */
export function instrumentReadAt(readAt) {
  let total = 0;
  return {
    readAt: async (position, length) => {
      const buf = await readAt(position, length);
      total += buf.length;
      return buf;
    },
    bytesRead: () => total,
  };
}

/** Encodes a text frame body: encoding byte + values joined by the encoding's null separator.
 * @param {number} encoding @param {string | string[]} values @returns {Buffer} */
export function textFrameBody(encoding, values) {
  const joined = (Array.isArray(values) ? values : [values]).join('\0');
  if (encoding === ENCODING.UTF8) return Buffer.concat([Buffer.from([3]), Buffer.from(joined, 'utf8'), Buffer.from([0])]);
  if (encoding === ENCODING.UTF16_BE) return Buffer.concat([Buffer.from([2]), swapEndian(Buffer.from(joined, 'utf16le')), Buffer.from([0, 0])]);
  if (encoding === ENCODING.UTF16_BOM) {
    return Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(joined, 'utf16le'), Buffer.from([0, 0])]);
  }
  return Buffer.concat([Buffer.from([0]), Buffer.from(joined, 'latin1'), Buffer.from([0])]);
}

/** Byte-swaps a UTF-16LE buffer into big-endian, in a fresh copy. @param {Buffer} buf @returns {Buffer} */
function swapEndian(buf) {
  const out = Buffer.from(buf);
  for (let i = 0; i + 1 < out.length; i += 2) {
    const tmp = out[i];
    out[i] = out[i + 1];
    out[i + 1] = tmp;
  }
  return out;
}

/** Encodes an APIC frame body (encoding, MIME, picture type, description, raw picture bytes).
 * @param {{ encoding?: number, mime?: string, pictureType?: number, description?: string, data: Buffer }} opts
 * @returns {Buffer} */
export function apicFrameBody({ encoding = ENCODING.LATIN1, mime = 'image/jpeg', pictureType = 3, description = '', data }) {
  const mimeBuf = Buffer.concat([Buffer.from(mime, 'latin1'), Buffer.from([0])]);
  const descBuf = textFrameBody(encoding, description).subarray(1);
  return Buffer.concat([Buffer.from([encoding]), mimeBuf, Buffer.from([pictureType]), descBuf, data]);
}

/** Writes a 28-bit synchsafe integer into `buf` at offset 0 (4 bytes). @param {Buffer} buf @param {number} value */
function writeSynchsafe32(buf, value) {
  buf[0] = (value >>> 21) & 0x7f;
  buf[1] = (value >>> 14) & 0x7f;
  buf[2] = (value >>> 7) & 0x7f;
  buf[3] = value & 0x7f;
}

/** Builds one ID3v2 frame's wire bytes (id + size + flags + body).
 * @param {{ id: string, body: Buffer, version?: number, forcePlainSize?: boolean, flags?: number }} opts
 * @returns {Buffer} */
export function buildFrame({ id, body, version = 4, forcePlainSize = false, flags = 0 }) {
  const sizeBuf = Buffer.alloc(4);
  if (version === 4 && !forcePlainSize) writeSynchsafe32(sizeBuf, body.length);
  else sizeBuf.writeUInt32BE(body.length, 0);
  return Buffer.concat([Buffer.from(id, 'latin1'), sizeBuf, Buffer.from([(flags >> 8) & 0xff, flags & 0xff]), body]);
}

/** Builds a v2.3/v2.4 extended header whose declared size the reader can skip exactly.
 * @param {number} version @returns {Buffer} */
function buildExtendedHeader(version) {
  if (version === 4) {
    const buf = Buffer.alloc(6); // synchsafe size includes itself: 6 bytes total
    writeSynchsafe32(buf, 6);
    return buf;
  }
  const buf = Buffer.alloc(10); // plain size excludes itself: 6 more bytes after it
  buf.writeUInt32BE(6, 0);
  return buf;
}

/** Applies the simplified sync scheme (`$00` inserted after every `$FF`), the inverse of the reader's `synchDecode`.
 * @param {Buffer} buf @returns {Buffer} */
function synchEncode(buf) {
  const out = [];
  for (const byte of buf) {
    out.push(byte);
    if (byte === 0xff) out.push(0x00);
  }
  return Buffer.from(out);
}

/** Builds a full ID3v2.3/2.4 tag (header + optional extended header + frames [+ padding]).
 * @param {{ version?: number, frames?: Buffer[], unsynchronisation?: boolean, extendedHeader?: boolean, padding?: number }} opts
 * @returns {Buffer} */
export function buildId3v2Tag({ version = 4, frames = [], unsynchronisation = false, extendedHeader = false, padding = 0 } = {}) {
  const framesBuf = Buffer.concat([...frames, Buffer.alloc(padding)]);
  const body = extendedHeader ? Buffer.concat([buildExtendedHeader(version), framesBuf]) : framesBuf;
  const finalBody = unsynchronisation ? synchEncode(body) : body;
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = version;
  header[5] = (unsynchronisation ? 0x80 : 0) | (extendedHeader ? 0x40 : 0);
  writeSynchsafe32(header.subarray(6), finalBody.length);
  return Buffer.concat([header, finalBody]);
}

/** @type {Record<number, number[]>} */
const SAMPLE_RATES = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] };
/** @type {Record<number, number[]>} */
const BITRATES_L3 = { 1: [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
/** @type {Record<number, number>} */
const VERSION_BITS = { 1: 0b11, 2: 0b10, 2.5: 0b00 };

/** Builds one silent, browser-decodable MPEG Layer III CBR frame (all-zero side info + data).
 * Defaults to the fixture standard: MPEG-1, 32 kHz, 32 kbit/s, mono.
 * @param {{ mpegVersion?: number, sampleRate?: number, bitrateKbps?: number, mono?: boolean }} opts
 * @returns {Buffer} */
export function buildMpegFrame({ mpegVersion = 1, sampleRate = 32000, bitrateKbps = 32, mono = true } = {}) {
  const rates = SAMPLE_RATES[mpegVersion];
  const bitrates = BITRATES_L3[mpegVersion === 1 ? 1 : 2];
  const sampleRateIdx = rates.indexOf(sampleRate);
  const bitrateIdx = bitrates.indexOf(bitrateKbps);
  if (sampleRateIdx === -1 || bitrateIdx === -1) throw new Error('unsupported fixture rate/bitrate');
  const b1 = 0xe0 | (VERSION_BITS[mpegVersion] << 3) | (0b01 << 1) | 1;
  const b2 = ((bitrateIdx + 1) << 4) | (sampleRateIdx << 2);
  const b3 = mono ? 0b11 << 6 : 0;
  const samplesPerFrame = mpegVersion === 1 ? 1152 : 576;
  const frameLength = Math.floor((samplesPerFrame / 8) * (bitrateKbps * 1000) / sampleRate);
  const frame = Buffer.alloc(frameLength);
  frame[0] = 0xff;
  frame[1] = b1;
  frame[2] = b2;
  frame[3] = b3;
  return frame;
}

/** Patches a Xing/Info frame-count header into a frame's side-info region (in place).
 * @param {Buffer} frame @param {{ frames: number, mpegVersion?: number, mono?: boolean }} opts @returns {Buffer} */
export function withXingHeader(frame, { frames, mpegVersion = 1, mono = true }) {
  const sideInfo = mpegVersion === 1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
  const offset = 4 + sideInfo;
  frame.write('Xing', offset, 'latin1');
  frame.writeUInt32BE(0x1, offset + 4);
  frame.writeUInt32BE(frames, offset + 8);
  return frame;
}

/** Patches a VBRI frame-count header at its fixed offset (in place).
 * @param {Buffer} frame @param {{ frames: number }} opts @returns {Buffer} */
export function withVbriHeader(frame, { frames }) {
  const offset = 4 + 32;
  frame.write('VBRI', offset, 'latin1');
  frame.writeUInt32BE(frames, offset + 14);
  return frame;
}
