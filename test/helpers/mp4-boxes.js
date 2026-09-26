// @ts-check

/**
 * Synthetic ISO-BMFF (MP4) box builders for tests. Each builder produces the
 * minimum bytes `src/library/tags/mp4-codec.js` needs to walk a box tree -
 * real MP4 boxes carry more fields, but the sniffer only reads box headers,
 * the `hdlr` handler type and the first `stsd` sample-entry fourcc.
 */

/**
 * @param {number} n
 * @returns {Buffer}
 */
function u32(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(n, 0);
  return buf;
}

/**
 * @param {bigint} n
 * @returns {Buffer}
 */
function u64(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(n, 0);
  return buf;
}

/**
 * Builds a box with a plain 32-bit size field.
 * @param {string} type four-character box type
 * @param {Buffer} [payload]
 * @returns {Buffer}
 */
export function boxBuf(type, payload = Buffer.alloc(0)) {
  return Buffer.concat([u32(8 + payload.length), Buffer.from(type, 'latin1'), payload]);
}

/**
 * Builds a box using the 64-bit "largesize" form (`size` field = 1, followed
 * by an 8-byte extended size).
 * @param {string} type four-character box type
 * @param {Buffer} [payload]
 * @returns {Buffer}
 */
export function box64Buf(type, payload = Buffer.alloc(0)) {
  const size = BigInt(16 + payload.length);
  return Buffer.concat([u32(1), Buffer.from(type, 'latin1'), u64(size), payload]);
}

/**
 * Builds an `hdlr` box carrying the given four-character handler type
 * (`'vide'`, `'soun'`, or anything else to be ignored by the sniffer).
 * @param {string} handlerType
 * @returns {Buffer}
 */
export function hdlrBox(handlerType) {
  const body = Buffer.concat([
    Buffer.alloc(8), // version/flags + pre_defined
    Buffer.from(handlerType, 'latin1'),
    Buffer.alloc(12), // reserved
  ]);
  return boxBuf('hdlr', body);
}

/**
 * Builds a minimal sample-entry: a box whose type IS the fourcc the sniffer
 * reads, with a little filler so it looks like a real entry.
 * @param {string} fourcc
 * @returns {Buffer}
 */
function sampleEntryBuf(fourcc) {
  return boxBuf(fourcc, Buffer.alloc(8));
}

/**
 * Builds an `stsd` box with exactly one sample entry.
 * @param {string} fourcc first (and only) sample-entry fourcc
 * @returns {Buffer}
 */
export function stsdBox(fourcc) {
  const header = Buffer.concat([Buffer.alloc(4), u32(1)]); // version/flags=0, entry_count=1
  return boxBuf('stsd', Buffer.concat([header, sampleEntryBuf(fourcc)]));
}

/**
 * Builds a `stbl` box containing only `stsd` (the sniffer never reads the
 * other sample tables).
 * @param {string} fourcc
 * @returns {Buffer}
 */
export function stblBox(fourcc) {
  return boxBuf('stbl', stsdBox(fourcc));
}

/**
 * Builds a `minf` box containing only `stbl`.
 * @param {string} fourcc
 * @returns {Buffer}
 */
export function minfBox(fourcc) {
  return boxBuf('minf', stblBox(fourcc));
}

/**
 * Builds a `mdia` box with `hdlr` and `minf`.
 * @param {string} handlerType
 * @param {string} fourcc
 * @returns {Buffer}
 */
export function mdiaBox(handlerType, fourcc) {
  return boxBuf('mdia', Buffer.concat([hdlrBox(handlerType), minfBox(fourcc)]));
}

/**
 * Builds a `trak` box for one track.
 * @param {string} handlerType `'vide'`, `'soun'`, or another handler type
 * @param {string} fourcc sample-entry fourcc for this track
 * @returns {Buffer}
 */
export function trakBox(handlerType, fourcc) {
  return boxBuf('trak', mdiaBox(handlerType, fourcc));
}

/**
 * Builds a `moov` box from one or more tracks.
 * @param {Array<{ handlerType: string, fourcc: string }>} tracks
 * @returns {Buffer}
 */
export function moovBox(tracks) {
  const traks = tracks.map((t) => trakBox(t.handlerType, t.fourcc));
  return boxBuf('moov', Buffer.concat(traks));
}

/**
 * Builds an `mdat` box with `size` bytes of zeroed filler payload, using the
 * 64-bit size form (for exercising the "moov after a 64-bit mdat" path).
 * @param {number} size payload byte count
 * @returns {Buffer}
 */
export function mdat64Box(size) {
  return box64Buf('mdat', Buffer.alloc(size));
}
