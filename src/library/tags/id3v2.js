// @ts-check
// Minimal, budgeted ID3v2.3/2.4 tag reader over a caller-supplied `readAt`
// seam. Never throws on malformed input; returns what it could parse.

/** @typedef {(position: number, length: number) => Promise<Buffer>} ReadAt */
/** @typedef {{ offset: number, length: number, mime: string }} PictureRef */
/** @typedef {{ version: number, fields: Record<string, string>, picture: PictureRef | null, tagEnd: number }} Id3v2Tag */
/** @typedef {{ budgetLeft: number, pictureCandidate: PictureRef | null, type3Candidate: PictureRef | null }} WalkState */

const MAX_BUDGET = 256 * 1024;
const CHUNK_SIZE = 64 * 1024;
const MAX_PICTURE_BYTES = 10 * 1024 * 1024;
const APIC_HEADER_MAX = 512;
const KNOWN_TEXT_IDS = new Set(['TIT2', 'TPE1', 'TPE2', 'TALB', 'TRCK', 'TPOS', 'TDRC', 'TYER']);
const FRAME_ID_RE = /^[A-Z0-9]{4}$/;

/**
 * Reads an ID3v2.3/2.4 tag through a budgeted, chunked `readAt` seam.
 * Never rejects on malformed data; returns `null` when no tag is present.
 * @param {ReadAt} readAt
 * @returns {Promise<Id3v2Tag | null>}
 */
export async function readId3v2(readAt) {
  const header = await readAt(0, 10);
  if (header.length < 10 || header.toString('latin1', 0, 3) !== 'ID3') return null;
  const version = header[3];
  if (version !== 3 && version !== 4) return null;
  const flags = header[5];
  const tagSize = decodeSynchsafe32(header, 6);
  const hasFooter = version === 4 && (flags & 0x10) !== 0;
  const frameAreaEnd = 10 + tagSize;
  const tagEnd = frameAreaEnd + (hasFooter ? 10 : 0);
  /** @type {Record<string, string>} */
  const fields = {};
  /** @type {WalkState} */
  const state = { budgetLeft: MAX_BUDGET - header.length, pictureCandidate: null, type3Candidate: null };
  const hasExtHeader = (flags & 0x40) !== 0;

  if ((flags & 0x80) !== 0) {
    await readUnsyncedTag(readAt, version, tagSize, hasExtHeader, fields, state);
    return { version, fields, picture: null, tagEnd };
  }
  let pos = 10;
  if (hasExtHeader) {
    const skipped = await skipExtendedHeader(readAt, pos, version, state);
    if (skipped === null) return { version, fields, picture: null, tagEnd };
    pos = skipped;
  }
  await walkFrames(readAt, pos, frameAreaEnd, version, fields, state);
  return { version, fields, picture: state.type3Candidate ?? state.pictureCandidate, tagEnd };
}

/** 28-bit synchsafe decode (each byte's top bit masked off). @param {Buffer} buf @param {number} offset @returns {number} */
function decodeSynchsafe32(buf, offset) {
  return ((buf[offset] & 0x7f) << 21) | ((buf[offset + 1] & 0x7f) << 14) |
    ((buf[offset + 2] & 0x7f) << 7) | (buf[offset + 3] & 0x7f);
}

/** True for a valid frame id or all-zero padding (v2.4 lookahead only). @param {Buffer | null} bytes @returns {boolean} */
function looksLikeBoundary(bytes) {
  if (!bytes || bytes.length < 4) return false;
  if (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0) return true;
  return FRAME_ID_RE.test(bytes.toString('latin1', 0, 4));
}

/** Reads up to `length` bytes at `position`, capped by the remaining budget; `null` when exhausted.
 * @param {ReadAt} readAt @param {number} position @param {number} length @param {{ budgetLeft: number }} state
 * @returns {Promise<Buffer | null>} */
async function boundedRead(readAt, position, length, state) {
  const want = Math.min(length, state.budgetLeft);
  if (want <= 0) return null;
  const buf = await readAt(position, want);
  state.budgetLeft -= buf.length;
  return buf;
}

/** v2.4 iTunes-bug guard: is `candidateEnd` a plausible next frame (or tag end)?
 * @param {ReadAt} readAt @param {number} candidateEnd @param {number} tagEnd @param {{ budgetLeft: number }} state
 * @returns {Promise<boolean>} */
async function isPlausibleNext(readAt, candidateEnd, tagEnd, state) {
  if (candidateEnd === tagEnd) return true;
  if (candidateEnd > tagEnd) return false;
  return looksLikeBoundary(await boundedRead(readAt, candidateEnd, 4, state));
}

/** Decodes a text frame body: encoding byte + text, first of `\0`-separated values.
 * @param {Buffer} body @returns {string} */
function decodeTextFrame(body) {
  const encoding = body[0];
  const rest = body.subarray(1);
  if (encoding === 1 || encoding === 2) return decodeUtf16Field(rest, encoding).split('\0')[0];
  return rest.toString(encoding === 3 ? 'utf8' : 'latin1').split('\0')[0];
}

/** UTF-16: encoding 1 has a leading BOM (either order), encoding 2 is big-endian without one.
 * @param {Buffer} bytes @param {number} encoding @returns {string} */
function decodeUtf16Field(bytes, encoding) {
  let data = bytes;
  let bigEndian = encoding === 2;
  if (encoding === 1 && bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    bigEndian = true;
    data = bytes.subarray(2);
  } else if (encoding === 1 && bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    data = bytes.subarray(2);
  }
  if (bigEndian) {
    const swapped = Buffer.from(data);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const tmp = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = tmp;
    }
    data = swapped;
  }
  return data.toString('utf16le', 0, data.length - (data.length % 2));
}

/** Finds a string terminator: one `$00` for Latin-1/UTF-8, an aligned `$00 $00` pair for UTF-16.
 * @param {Buffer} buf @param {number} start @param {number} termLen @returns {number} */
function findTerminator(buf, start, termLen) {
  if (termLen === 1) return buf.indexOf(0x00, start);
  for (let i = start; i + 1 < buf.length; i += 2) {
    if (buf[i] === 0 && buf[i + 1] === 0) return i;
  }
  return -1;
}

/** Parses a (budget-truncated) APIC body header and locates the picture bytes without reading them.
 * @param {Buffer} buf @param {number} frameSize @param {number} bodyStart
 * @returns {{ type: number, ref: PictureRef } | null} */
function parseApicHeader(buf, frameSize, bodyStart) {
  if (buf.length < 2) return null;
  const encoding = buf[0];
  const mimeEnd = buf.indexOf(0x00, 1);
  if (mimeEnd === -1) return null;
  let mime = buf.toString('latin1', 1, mimeEnd).toLowerCase();
  let cursor = mimeEnd + 1;
  if (cursor >= buf.length) return null;
  const pictureType = buf[cursor];
  cursor += 1;
  const descEnd = findTerminator(buf, cursor, encoding === 1 || encoding === 2 ? 2 : 1);
  if (descEnd === -1) return null;
  cursor = descEnd + (encoding === 1 || encoding === 2 ? 2 : 1);
  if (mime === 'image/jpg') mime = 'image/jpeg';
  if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp') return null;
  const length = frameSize - cursor;
  if (length <= 0 || length > MAX_PICTURE_BYTES) return null;
  return { type: pictureType, ref: { offset: bodyStart + cursor, length, mime } };
}

/** Reads only an APIC frame's header (budgeted) and updates the picture candidates.
 * @param {ReadAt} readAt @param {number} bodyStart @param {number} size @param {WalkState} state
 * @returns {Promise<void>} */
async function handleApic(readAt, bodyStart, size, state) {
  const want = Math.min(APIC_HEADER_MAX, size, state.budgetLeft);
  if (want <= 0) return;
  const buf = await readAt(bodyStart, want);
  state.budgetLeft -= buf.length;
  const parsed = parseApicHeader(buf, size, bodyStart);
  if (!parsed) return;
  if (!state.pictureCandidate) state.pictureCandidate = parsed.ref;
  if (parsed.type === 3 && !state.type3Candidate) state.type3Candidate = parsed.ref;
}

/** Reads and decodes a known text frame's full body; first occurrence wins.
 * @param {ReadAt} readAt @param {number} bodyStart @param {number} size @param {string} id
 * @param {WalkState} state @param {Record<string, string>} fields @returns {Promise<void>} */
async function handleTextFrame(readAt, bodyStart, size, id, state, fields) {
  const body = await boundedRead(readAt, bodyStart, size, state);
  if (!body || body.length < size) return;
  fields[id] = decodeTextFrame(body);
}

/** Skips compressed/encrypted frames; reads known text frames and APIC; ignores the rest.
 * @param {ReadAt} readAt @param {string} id @param {number} flagsByte2 @param {number} version
 * @param {number} bodyStart @param {number} size @param {Record<string, string>} fields @param {WalkState} state
 * @returns {Promise<void>} */
async function processFrame(readAt, id, flagsByte2, version, bodyStart, size, fields, state) {
  const compressedMask = version === 4 ? 0x08 : 0x80;
  const encryptedMask = version === 4 ? 0x04 : 0x40;
  if ((flagsByte2 & compressedMask) !== 0 || (flagsByte2 & encryptedMask) !== 0) return;
  if (id === 'APIC') return handleApic(readAt, bodyStart, size, state);
  if (KNOWN_TEXT_IDS.has(id) && size > 0 && size <= CHUNK_SIZE && !(id in fields)) {
    await handleTextFrame(readAt, bodyStart, size, id, state, fields);
  }
}

/** Skips the extended header (v2.3 size excludes itself, v2.4 size includes itself).
 * @param {ReadAt} readAt @param {number} pos @param {number} version @param {WalkState} state
 * @returns {Promise<number | null>} */
async function skipExtendedHeader(readAt, pos, version, state) {
  const sizeBuf = await boundedRead(readAt, pos, 4, state);
  if (!sizeBuf || sizeBuf.length < 4) return null;
  const extSize = version === 4 ? decodeSynchsafe32(sizeBuf, 0) : sizeBuf.readUInt32BE(0);
  return pos + 4 + (version === 4 ? Math.max(0, extSize - 4) : extSize);
}

/** Walks frames until padding, an invalid id, an out-of-range size, truncation or budget exhaustion.
 * @param {ReadAt} readAt @param {number} startPos @param {number} tagEnd @param {number} version
 * @param {Record<string, string>} fields @param {WalkState} state @returns {Promise<void>} */
async function walkFrames(readAt, startPos, tagEnd, version, fields, state) {
  let pos = startPos;
  while (pos + 10 <= tagEnd && state.budgetLeft > 0) {
    const header = await boundedRead(readAt, pos, 10, state);
    if (!header || header.length < 10) break;
    if (header[0] === 0 && header[1] === 0 && header[2] === 0 && header[3] === 0) break;
    const id = header.toString('latin1', 0, 4);
    if (!FRAME_ID_RE.test(id)) break;
    let size = header.readUInt32BE(4);
    if (version === 4) {
      const synchsafe = decodeSynchsafe32(header, 4);
      if (await isPlausibleNext(readAt, pos + 10 + synchsafe, tagEnd, state)) size = synchsafe;
    }
    const bodyEnd = pos + 10 + size;
    if (bodyEnd > tagEnd) break;
    await processFrame(readAt, id, header[9], version, pos + 10, size, fields, state);
    pos = bodyEnd;
  }
}

/** Reverses the simplified sync scheme (`$00` inserted after every `$FF`) of a whole v2.3 tag.
 * @param {Buffer} buf @returns {Buffer} */
function synchDecode(buf) {
  const out = Buffer.alloc(buf.length);
  let w = 0;
  for (let i = 0; i < buf.length; i++) {
    out[w] = buf[i];
    w += 1;
    if (buf[i] === 0xff && buf[i + 1] === 0x00) i += 1;
  }
  return out.subarray(0, w);
}

/** In-memory extended-header skip over an already de-unsynced buffer.
 * @param {Buffer} buf @param {number} pos @param {number} version @returns {number | null} */
function skipExtendedHeaderInMemory(buf, pos, version) {
  if (pos + 4 > buf.length) return null;
  const extSize = version === 4 ? decodeSynchsafe32(buf, pos) : buf.readUInt32BE(pos);
  return pos + 4 + (version === 4 ? Math.max(0, extSize - 4) : extSize);
}

/** In-memory equivalent of the v2.4 synchsafe-size-with-fallback rule.
 * @param {Buffer} buf @param {number} pos @param {number} bufLen @param {number} version @returns {number} */
function decodeFrameSizeSync(buf, pos, bufLen, version) {
  const plain = buf.readUInt32BE(pos + 4);
  if (version !== 4) return plain;
  const synchsafe = decodeSynchsafe32(buf, pos + 4);
  const candidateEnd = pos + 10 + synchsafe;
  const plausible = candidateEnd === bufLen ||
    (candidateEnd < bufLen && looksLikeBoundary(buf.subarray(candidateEnd, candidateEnd + 4)));
  return plausible ? synchsafe : plain;
}

/** Walks an already-de-unsynced, in-memory tag buffer. Pictures are never extracted here
 * (unsynchronised-tag pictures are ignored per the ID3v2 robustness rule).
 * @param {Buffer} buf @param {number} startPos @param {number} version @param {Record<string, string>} fields
 * @returns {void} */
function walkFramesInMemory(buf, startPos, version, fields) {
  let pos = startPos;
  const bufLen = buf.length;
  while (pos + 10 <= bufLen) {
    if (buf[pos] === 0 && buf[pos + 1] === 0 && buf[pos + 2] === 0 && buf[pos + 3] === 0) break;
    const id = buf.toString('latin1', pos, pos + 4);
    if (!FRAME_ID_RE.test(id)) break;
    const flagsByte2 = buf[pos + 9];
    const size = decodeFrameSizeSync(buf, pos, bufLen, version);
    const bodyStart = pos + 10;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > bufLen) break;
    const compressedMask = version === 4 ? 0x08 : 0x80;
    const encryptedMask = version === 4 ? 0x04 : 0x40;
    const readable = (flagsByte2 & compressedMask) === 0 && (flagsByte2 & encryptedMask) === 0;
    if (readable && id !== 'APIC' && KNOWN_TEXT_IDS.has(id) && size > 0 && !(id in fields)) {
      fields[id] = decodeTextFrame(buf.subarray(bodyStart, bodyEnd));
    }
    pos = bodyEnd;
  }
}

/** Reads a whole-tag-unsynchronised v2.3 tag in one budgeted shot, de-unsynchronises it,
 * then walks it fully in memory.
 * @param {ReadAt} readAt @param {number} version @param {number} tagSize @param {boolean} hasExtHeader
 * @param {Record<string, string>} fields @param {WalkState} state @returns {Promise<void>} */
async function readUnsyncedTag(readAt, version, tagSize, hasExtHeader, fields, state) {
  const want = Math.min(tagSize, state.budgetLeft);
  if (want <= 0) return;
  const raw = await readAt(10, want);
  state.budgetLeft -= raw.length;
  const clean = synchDecode(raw);
  let pos = 0;
  if (hasExtHeader) {
    const skipped = skipExtendedHeaderInMemory(clean, pos, version);
    if (skipped === null) return;
    pos = skipped;
  }
  walkFramesInMemory(clean, pos, version, fields);
}
