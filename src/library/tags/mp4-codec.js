// @ts-check
import { open } from 'node:fs/promises';

/**
 * Header-only MP4/ISO-BMFF codec sniffer. Walks top-level boxes to `moov`,
 * then `trak` -> `mdia` -> `hdlr` (handler type) and `mdia` -> `minf` ->
 * `stbl` -> `stsd` (first sample-entry fourcc), reading only box headers
 * through one `FileHandle` opened `'r'`. Never reads `mdat` payloads, so a
 * `moov` at the end of a multi-GB file costs a handful of small reads.
 */

/** @typedef {{ video: string[], audio: string[] }} SniffedCodecs */

const MAX_BOXES_PER_LEVEL = 64;
// The fixed trak -> mdia -> hdlr/minf -> stbl -> stsd walk below never nests
// past depth 5, so this guard cannot trigger today; it stays as a safety net
// against a future caller adding deeper recursion.
const MAX_DEPTH = 8;
const MAX_READ_BYTES = 64 * 1024;

/** Thrown internally on any guard violation or I/O truncation; always caught. */
class SniffAbort extends Error {}

/** @typedef {{ fh: import('node:fs/promises').FileHandle, bytesRead: number }} SniffState */
/** @typedef {{ type: string, contentStart: number, end: number }} BoxHeader */

/**
 * Reads `length` bytes at `offset`, tracking the cumulative read budget.
 * @param {SniffState} state
 * @param {number} offset
 * @param {number} length
 * @returns {Promise<Buffer>}
 */
async function readBytes(state, offset, length) {
  state.bytesRead += length;
  if (state.bytesRead > MAX_READ_BYTES) throw new SniffAbort('read budget exceeded');
  const buf = Buffer.allocUnsafe(length);
  const { bytesRead } = await state.fh.read(buf, 0, length, offset);
  if (bytesRead !== length) throw new SniffAbort('truncated read');
  return buf;
}

/**
 * Parses one box header (32- or 64-bit size, size 0 = to the end of `limit`)
 * at `offset`. Returns `null` when there is no room left for another header
 * (end of a valid sibling list); throws `SniffAbort` when the declared size
 * is smaller than its own header or does not fit inside `limit`.
 * @param {SniffState} state
 * @param {number} offset
 * @param {number} limit end of the enclosing box/file
 * @returns {Promise<BoxHeader | null>}
 */
async function readBoxHeader(state, offset, limit) {
  if (offset + 8 > limit) return null;
  const head = await readBytes(state, offset, 8);
  let size = head.readUInt32BE(0);
  const type = head.toString('latin1', 4, 8);
  let headerSize = 8;
  if (size === 1) {
    const ext = await readBytes(state, offset + 8, 8);
    const big = ext.readBigUInt64BE(0);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new SniffAbort('box too large');
    size = Number(big);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset;
  }
  if (size < headerSize) throw new SniffAbort('box smaller than its header');
  const end = offset + size;
  if (end > limit) throw new SniffAbort('box overflows its parent');
  return { type, contentStart: offset + headerSize, end };
}

/**
 * Scans one level of sibling boxes in `[start, end)` for every box of
 * `targetType`. Guards: at most `MAX_BOXES_PER_LEVEL` boxes scanned, at most
 * `MAX_DEPTH` nesting.
 * @param {SniffState} state
 * @param {number} start
 * @param {number} end
 * @param {string} targetType
 * @param {number} depth
 * @returns {Promise<BoxHeader[]>}
 */
async function findAllBoxes(state, start, end, targetType, depth) {
  if (depth > MAX_DEPTH) throw new SniffAbort('max depth exceeded');
  /** @type {BoxHeader[]} */
  const results = [];
  let offset = start;
  for (let count = 0; offset + 8 <= end; count += 1) {
    if (count >= MAX_BOXES_PER_LEVEL) throw new SniffAbort('too many boxes');
    const box = await readBoxHeader(state, offset, end);
    if (!box) break;
    if (box.type === targetType) results.push(box);
    offset = box.end;
  }
  return results;
}

/**
 * Scans one level of sibling boxes for the first box of `targetType`,
 * stopping as soon as it is found (unlike `findAllBoxes`, it never walks the
 * remaining siblings), or returns `null` when none is present before the
 * level ends (not a guard violation - the caller decides whether a missing
 * box skips its subtree or fails the whole walk). Stopping at the first match
 * keeps a fragmented file (`moov` followed by many `moof`/`mdat` pairs) from
 * running the box-count guard against trailing siblings the walk never needed.
 * @param {SniffState} state
 * @param {number} start
 * @param {number} end
 * @param {string} targetType
 * @param {number} depth
 * @returns {Promise<BoxHeader | null>}
 */
async function findBox(state, start, end, targetType, depth) {
  if (depth > MAX_DEPTH) throw new SniffAbort('max depth exceeded');
  let offset = start;
  for (let count = 0; offset + 8 <= end; count += 1) {
    if (count >= MAX_BOXES_PER_LEVEL) throw new SniffAbort('too many boxes');
    const box = await readBoxHeader(state, offset, end);
    if (!box) break;
    if (box.type === targetType) return box;
    offset = box.end;
  }
  return null;
}

/**
 * Reads the 4-character handler type from an already-located `hdlr` box.
 * @param {SniffState} state
 * @param {BoxHeader} hdlr
 * @returns {Promise<string | null>}
 */
async function readHandlerType(state, hdlr) {
  if (hdlr.end - hdlr.contentStart < 12) return null;
  const buf = await readBytes(state, hdlr.contentStart + 8, 4);
  return buf.toString('latin1');
}

/**
 * Reads the first sample-entry fourcc from an already-located `stsd` box.
 * @param {SniffState} state
 * @param {BoxHeader} stsd
 * @returns {Promise<string | null>}
 */
async function readFirstSampleEntryFourcc(state, stsd) {
  if (stsd.end - stsd.contentStart < 16) return null;
  const header = await readBytes(state, stsd.contentStart, 8);
  const entryCount = header.readUInt32BE(4);
  if (entryCount < 1) return null;
  const format = await readBytes(state, stsd.contentStart + 12, 4);
  return format.toString('latin1');
}

/**
 * Resolves the handler type and first sample-entry fourcc of one `trak` box.
 * Returns `null` when the track has no usable media type (missing `mdia`,
 * `hdlr`, `minf`, `stbl`, `stsd`, or an empty `stsd`) - not a guard
 * violation, so a track like a hint or timecode track never fails the walk.
 * @param {SniffState} state
 * @param {BoxHeader} trak
 * @returns {Promise<{ handlerType: string, fourcc: string } | null>}
 */
async function readTrack(state, trak) {
  const mdia = await findBox(state, trak.contentStart, trak.end, 'mdia', 2);
  if (!mdia) return null;
  const hdlr = await findBox(state, mdia.contentStart, mdia.end, 'hdlr', 3);
  const minf = await findBox(state, mdia.contentStart, mdia.end, 'minf', 3);
  if (!hdlr || !minf) return null;
  const handlerType = await readHandlerType(state, hdlr);
  if (!handlerType) return null;
  const stbl = await findBox(state, minf.contentStart, minf.end, 'stbl', 4);
  if (!stbl) return null;
  const stsd = await findBox(state, stbl.contentStart, stbl.end, 'stsd', 5);
  if (!stsd) return null;
  const fourcc = await readFirstSampleEntryFourcc(state, stsd);
  return fourcc ? { handlerType, fourcc } : null;
}

/**
 * Sniffs the sample-entry fourcc of every video (`vide`) and audio (`soun`)
 * track of an MP4-family file. Never throws: a truncated file, a missing
 * `moov`, or any malformed/looping/oversized box yields `null` ("unknown"),
 * which the caller treats as playable by extension.
 * @param {string} absPath absolute path to the file
 * @returns {Promise<SniffedCodecs | null>}
 */
export async function sniffMp4Codecs(absPath) {
  /** @type {import('node:fs/promises').FileHandle | undefined} */
  let fh;
  try {
    fh = await open(absPath, 'r');
    const { size: fileSize } = await fh.stat();
    /** @type {SniffState} */
    const state = { fh, bytesRead: 0 };
    const moov = await findBox(state, 0, fileSize, 'moov', 0);
    if (!moov) return null;
    const traks = await findAllBoxes(state, moov.contentStart, moov.end, 'trak', 1);
    /** @type {SniffedCodecs} */
    const codecs = { video: [], audio: [] };
    for (const trak of traks) {
      const track = await readTrack(state, trak);
      if (track?.handlerType === 'vide') codecs.video.push(track.fourcc);
      else if (track?.handlerType === 'soun') codecs.audio.push(track.fourcc);
    }
    return codecs;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}
