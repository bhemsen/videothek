/**
 * Test-only FLAC file builder: STREAMINFO, VORBIS_COMMENT, PICTURE blocks, an
 * optional minimal ID3v2 prefix and silent CONSTANT-subframe audio frames
 * with correct CRC-8/CRC-16, for `test/library/tags/flac.test.js` and reuse
 * by the committed-fixture generator.
 *
 * @see docs/specs/spec-music-audiobooks.md — "Fixtures".
 */

/**
 * @param {object} [opts]
 * @param {number} [opts.sampleRate] Sample rate in Hz.
 * @param {number} [opts.channels] 1 (mono) or 2 (independent stereo).
 * @param {number} [opts.bitsPerSample] Must be a multiple of 8.
 * @param {number} [opts.totalSamples] STREAMINFO total sample count.
 * @param {Record<string, string> | [string, string][]} [opts.vorbisComments]
 * @param {(Record<string, string> | [string, string][])[]} [opts.extraVorbisCommentBlocks]
 *   Additional VORBIS_COMMENT blocks appended after the primary one. Real
 *   encoders emit only one; this is for exercising the reader's handling of a
 *   malformed file that repeats the block.
 * @param {{ type?: number, mime?: string, description?: string, data?: Buffer }[]} [opts.pictures]
 * @param {boolean | { version?: number, footer?: boolean }} [opts.leadingId3v2]
 *   Prepend a minimal ID3v2 tag; `true` defaults to a v2.3 tag with no footer.
 * @param {number} [opts.vorbisPaddingBytes] Inflates the VORBIS_COMMENT block.
 * @param {boolean} [opts.includeFrames] Whether to append audio frames.
 * @param {number} [opts.blockSize] Samples per frame.
 * @returns {Buffer} A complete, spec-shaped FLAC file.
 */
export function buildFlacFile(opts = {}) {
  const {
    sampleRate = 44100,
    channels = 1,
    bitsPerSample = 16,
    totalSamples = 0,
    vorbisComments = { TITLE: 'Test' },
    extraVorbisCommentBlocks = [],
    pictures = [],
    leadingId3v2 = false,
    vorbisPaddingBytes = 0,
    includeFrames = true,
    blockSize = 4096,
  } = opts;

  const blocks = [
    { type: 0, content: buildStreamInfoBlock({ sampleRate, channels, bitsPerSample, totalSamples, blockSize }) },
    { type: 4, content: buildVorbisCommentBlock(vorbisComments, vorbisPaddingBytes) },
    ...extraVorbisCommentBlocks.map((comments) => ({ type: 4, content: buildVorbisCommentBlock(comments, 0) })),
    ...pictures.map((picture) => ({ type: 6, content: buildPictureBlock(picture) })),
  ];

  const prefix = leadingId3v2 ? buildId3v2Prefix(typeof leadingId3v2 === 'object' ? leadingId3v2 : {}) : Buffer.alloc(0);
  const frames = includeFrames
    ? buildFrames({ totalSamples, blockSize, channels, bitsPerSample })
    : Buffer.alloc(0);
  return Buffer.concat([prefix, Buffer.from('fLaC', 'ascii'), assembleMetadataBlocks(blocks), frames]);
}

/** @param {{ type: number, content: Buffer }[]} blocks */
function assembleMetadataBlocks(blocks) {
  /** @type {Buffer[]} */
  const parts = [];
  blocks.forEach(({ type, content }, i) => {
    const header = Buffer.alloc(4);
    header[0] = (i === blocks.length - 1 ? 0x80 : 0) | (type & 0x7f);
    header.writeUIntBE(content.length, 1, 3);
    parts.push(header, content);
  });
  return Buffer.concat(parts);
}

/** @param {{ sampleRate: number, channels: number, bitsPerSample: number, totalSamples: number, blockSize: number }} p */
function buildStreamInfoBlock({ sampleRate, channels, bitsPerSample, totalSamples, blockSize }) {
  const buf = Buffer.alloc(34);
  buf.writeUInt16BE(blockSize, 0);
  buf.writeUInt16BE(blockSize, 2);
  const packed =
    (BigInt(sampleRate) << 44n) |
    (BigInt(channels - 1) << 41n) |
    (BigInt(bitsPerSample - 1) << 36n) |
    BigInt(totalSamples);
  buf.writeUInt32BE(Number((packed >> 32n) & 0xffffffffn), 10);
  buf.writeUInt32BE(Number(packed & 0xffffffffn), 14);
  return buf; // min/max frame size and MD5 left at 0 ("not known")
}

/**
 * @param {Record<string, string> | [string, string][]} comments
 * @param {number} paddingBytes
 */
function buildVorbisCommentBlock(comments, paddingBytes) {
  const vendor = Buffer.from('videothek-flac-fixture', 'utf8');
  const entries = Array.isArray(comments) ? comments.slice() : Object.entries(comments);
  if (paddingBytes > 0) entries.push(['PAD', 'x'.repeat(paddingBytes)]);

  const entryBuffers = entries.map(([key, value]) => {
    const text = Buffer.from(`${key}=${value}`, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(text.length, 0);
    return Buffer.concat([len, text]);
  });
  const vendorLen = Buffer.alloc(4);
  vendorLen.writeUInt32LE(vendor.length, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(entries.length, 0);
  return Buffer.concat([vendorLen, vendor, count, ...entryBuffers]);
}

/** @param {{ type?: number, mime?: string, description?: string, data?: Buffer }} picture */
function buildPictureBlock({ type = 3, mime = 'image/jpeg', description = '', data = Buffer.alloc(4) }) {
  const mimeBuf = Buffer.from(mime, 'ascii');
  const descBuf = Buffer.from(description, 'utf8');
  const head = Buffer.alloc(4 + 4 + mimeBuf.length + 4 + descBuf.length + 16 + 4);
  let o = 0;
  head.writeUInt32BE(type, o); o += 4;
  head.writeUInt32BE(mimeBuf.length, o); o += 4;
  mimeBuf.copy(head, o); o += mimeBuf.length;
  head.writeUInt32BE(descBuf.length, o); o += 4;
  descBuf.copy(head, o); o += descBuf.length + 16; // width/height/depth/colors left 0
  head.writeUInt32BE(data.length, o);
  return Buffer.concat([head, data]);
}

/**
 * A minimal ID3v2 tag with no frames, used to test the FLAC leading-tag skip.
 *
 * @param {{ version?: number, footer?: boolean }} [opts]
 */
function buildId3v2Prefix({ version = 3, footer = false } = {}) {
  const body = Buffer.alloc(16);
  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'ascii');
  header[3] = version;
  header[5] = footer ? 0x10 : 0; // footer-present flag (ID3v2.4 only)
  writeSynchsafe(header, 6, body.length);
  const footerBuf = footer ? buildId3v2Footer(version, body.length) : Buffer.alloc(0);
  return Buffer.concat([header, body, footerBuf]);
}

/** @param {number} version @param {number} size */
function buildId3v2Footer(version, size) {
  const footer = Buffer.alloc(10);
  footer.write('3DI', 0, 'ascii');
  footer[3] = version;
  writeSynchsafe(footer, 6, size);
  return footer;
}

/** @param {Buffer} buf @param {number} offset @param {number} value */
function writeSynchsafe(buf, offset, value) {
  buf[offset] = (value >> 21) & 0x7f;
  buf[offset + 1] = (value >> 14) & 0x7f;
  buf[offset + 2] = (value >> 7) & 0x7f;
  buf[offset + 3] = value & 0x7f;
}

/** @param {{ totalSamples: number, blockSize: number, channels: number, bitsPerSample: number }} p */
function buildFrames({ totalSamples, blockSize, channels, bitsPerSample }) {
  const frames = [];
  let remaining = totalSamples;
  let frameNumber = 0;
  while (remaining > 0) {
    const size = Math.min(blockSize, remaining);
    frames.push(buildFrame({ blockSize: size, channels, bitsPerSample, frameNumber }));
    remaining -= size;
    frameNumber += 1;
  }
  return Buffer.concat(frames);
}

/** @param {{ blockSize: number, channels: number, bitsPerSample: number, frameNumber: number }} p */
function buildFrame({ blockSize, channels, bitsPerSample, frameNumber }) {
  if (bitsPerSample % 8 !== 0) throw new Error('bitsPerSample must be a multiple of 8');
  if (channels !== 1 && channels !== 2) throw new Error('only 1 or 2 channels are supported');
  const blockSizeField = Buffer.alloc(2);
  blockSizeField.writeUInt16BE(blockSize - 1, 0);
  const header = Buffer.concat([
    Buffer.from([0xff, 0xf8]), // sync + reserved(0) + fixed blocksize
    Buffer.from([(0b0111 << 4) | 0b0000]), // block size: 16-bit follows; sample rate: from STREAMINFO
    Buffer.from([((channels - 1) << 4) | 0b0000]), // channel assignment; sample size: from STREAMINFO
    encodeUtf8Like(frameNumber),
    blockSizeField,
  ]);
  const headerWithCrc = Buffer.concat([header, Buffer.from([crc8(header)])]);
  const subframes = Buffer.concat(
    Array.from({ length: channels }, () => buildConstantSubframe(bitsPerSample)),
  );
  const beforeFooter = Buffer.concat([headerWithCrc, subframes]);
  const footer = Buffer.alloc(2);
  footer.writeUInt16BE(crc16(beforeFooter), 0);
  return Buffer.concat([beforeFooter, footer]);
}

/**
 * A CONSTANT subframe encoding digital silence (sample value 0).
 * @param {number} bitsPerSample
 */
function buildConstantSubframe(bitsPerSample) {
  return Buffer.alloc(1 + bitsPerSample / 8); // header 0x00 (CONSTANT, no wasted bits) + zero sample
}

/**
 * FLAC's "UTF-8-like" variable-length integer coding, up to 3 bytes (~2M).
 * @param {number} value
 */
function encodeUtf8Like(value) {
  if (value < 0x80) return Buffer.from([value]);
  if (value < 0x800) return Buffer.from([0xc0 | (value >> 6), 0x80 | (value & 0x3f)]);
  if (value < 0x10000) {
    return Buffer.from([0xe0 | (value >> 12), 0x80 | ((value >> 6) & 0x3f), 0x80 | (value & 0x3f)]);
  }
  throw new Error('frame number too large for this fixture builder');
}

/**
 * Bit-by-bit CRC-8 (poly 0x07, init 0), matching FLAC's frame header CRC.
 * @param {Buffer} buf
 */
function crc8(buf) {
  let crc = 0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

/**
 * Bit-by-bit CRC-16 (poly 0x8005, init 0), matching FLAC's frame footer CRC.
 * @param {Buffer} buf
 */
function crc16(buf) {
  let crc = 0;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x8005) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/**
 * Walks the metadata block chain of a buffer built by {@link buildFlacFile}
 * and returns the byte offset where the audio frame stream begins (right
 * after the last metadata block). Independent of `src/library/tags/flac.js`.
 *
 * @param {Buffer} buf A buffer built by {@link buildFlacFile}.
 * @returns {number}
 */
export function findFrameStart(buf) {
  let pos = buf.indexOf('fLaC', 0, 'ascii') + 4;
  let last = false;
  while (!last) {
    const header = buf.subarray(pos, pos + 4);
    last = (header[0] & 0x80) !== 0;
    const length = (header[1] << 16) | (header[2] << 8) | header[3];
    pos += 4 + length;
  }
  return pos;
}

/**
 * Wraps a Buffer as a `readAt(position, length) => Promise<Buffer>` function,
 * matching the reader contract (short buffer at EOF, never rejects).
 *
 * @param {Buffer} buffer
 * @returns {(position: number, length: number) => Promise<Buffer>}
 */
export function readAtFromBuffer(buffer) {
  return async (position, length) => {
    const start = Math.min(Math.max(position, 0), buffer.length);
    const end = Math.min(start + Math.max(length, 0), buffer.length);
    return buffer.subarray(start, end);
  };
}

/**
 * Like {@link readAtFromBuffer} but also counts bytes actually read, for
 * asserting the reader stays within its read budget.
 *
 * @param {Buffer} buffer
 * @returns {{ readAt: (position: number, length: number) => Promise<Buffer>, bytesRead: () => number }}
 */
export function countingReadAt(buffer) {
  const at = readAtFromBuffer(buffer);
  let total = 0;
  return {
    readAt: async (position, length) => {
      const buf = await at(position, length);
      total += buf.length;
      return buf;
    },
    bytesRead: () => total,
  };
}
