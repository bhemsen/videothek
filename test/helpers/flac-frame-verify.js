/**
 * Independent CRC-8/CRC-16 (table-driven, unlike the fixture builder's
 * bit-by-bit implementation) and a FLAC audio-frame walker, used by
 * `test/library/tags/flac.test.js` to verify frames the fixture builder
 * (`test/helpers/flac-fixture.js`) writes without trusting its own CRC code.
 */

import assert from 'node:assert/strict';

/** @param {number} poly @param {8 | 16} width */
function buildCrcTable(poly, width) {
  const top = width === 8 ? 0x80 : 0x8000;
  const mask = width === 8 ? 0xff : 0xffff;
  const table = new Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = width === 8 ? i : i << 8;
    for (let bit = 0; bit < 8; bit++) crc = crc & top ? ((crc << 1) ^ poly) & mask : (crc << 1) & mask;
    table[i] = crc;
  }
  return table;
}

const CRC8_TABLE = buildCrcTable(0x07, 8);
const CRC16_TABLE = buildCrcTable(0x8005, 16);

/**
 * CRC-8 (poly 0x07, init 0), matching FLAC's frame header CRC.
 * @param {Buffer} buf
 */
export function crc8(buf) {
  let crc = 0;
  for (const byte of buf) crc = CRC8_TABLE[(crc ^ byte) & 0xff];
  return crc;
}

/**
 * CRC-16 (poly 0x8005, init 0), matching FLAC's frame footer CRC.
 * @param {Buffer} buf
 */
export function crc16(buf) {
  let crc = 0;
  for (const byte of buf) crc = ((crc << 8) & 0xffff) ^ CRC16_TABLE[((crc >> 8) ^ byte) & 0xff];
  return crc;
}

/**
 * Byte length of a FLAC "UTF-8-like" value as the fixture builder encodes it.
 * @param {Buffer} buf
 * @param {number} offset
 */
function utf8LikeByteLength(buf, offset) {
  const lead = buf[offset];
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  throw new Error(`unsupported frame-number lead byte 0x${lead.toString(16)}`);
}

/** @param {Buffer} buf @param {number} offset @param {number} byteLength */
function decodeUtf8Like(buf, offset, byteLength) {
  const lead = buf[offset];
  if (byteLength === 1) return lead;
  if (byteLength === 2) return ((lead & 0x1f) << 6) | (buf[offset + 1] & 0x3f);
  return ((lead & 0x0f) << 12) | ((buf[offset + 1] & 0x3f) << 6) | (buf[offset + 2] & 0x3f);
}

/**
 * Walks the CONSTANT-subframe audio frames the fixture builder appends,
 * independently verifying sync code, header CRC-8, footer CRC-16 and frame
 * numbering. Returns each frame's block size for the caller to check counts
 * and totals.
 *
 * @param {Buffer} buf
 * @param {number} frameStart
 * @param {{ channels: number, bitsPerSample: number }} p
 * @returns {{ blockSize: number }[]}
 */
export function walkFrames(buf, frameStart, { channels, bitsPerSample }) {
  const subframeSize = 1 + bitsPerSample / 8;
  const frames = [];
  let pos = frameStart;
  let frameNumber = 0;
  while (pos < buf.length) {
    assert.equal(buf[pos], 0xff, `frame ${frameNumber}: sync byte 0`);
    assert.equal(buf[pos + 1], 0xf8, `frame ${frameNumber}: sync byte 1`);
    const numLen = utf8LikeByteLength(buf, pos + 4);
    assert.equal(decodeUtf8Like(buf, pos + 4, numLen), frameNumber, `frame ${frameNumber}: frame number`);
    const blockSizeFieldOffset = pos + 4 + numLen;
    const blockSize = buf.readUInt16BE(blockSizeFieldOffset) + 1;
    const headerEnd = blockSizeFieldOffset + 2;
    assert.equal(buf[headerEnd], crc8(buf.subarray(pos, headerEnd)), `frame ${frameNumber}: CRC-8`);
    const subframesEnd = headerEnd + 1 + channels * subframeSize;
    const footer = buf.readUInt16BE(subframesEnd);
    assert.equal(footer, crc16(buf.subarray(pos, subframesEnd)), `frame ${frameNumber}: CRC-16`);
    frames.push({ blockSize });
    pos = subframesEnd + 2;
    frameNumber += 1;
  }
  return frames;
}
