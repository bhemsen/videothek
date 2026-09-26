// @ts-check
// MPEG-1/2/2.5 Layer III duration without decoding: Xing/VBRI frame counts
// when present, else a CBR byte/bitrate estimate. Never throws.

/** @typedef {import('./id3v2.js').ReadAt} ReadAt */
/** @typedef {{ isV1: boolean, sampleRate: number, bitrateKbps: number, padding: number, channelMode: number, samplesPerFrame: number }} FrameHeader */

const SYNC_WINDOW = 64 * 1024;
const PROBE_SIZE = 1024;
/** @type {Record<number, number[]>} versionBits (0=MPEG2.5, 2=MPEG2, 3=MPEG1) -> sample rates */
const SAMPLE_RATE_TABLE = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const BITRATE_L3_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATE_L3_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];

/**
 * Estimates an MP3's duration without decoding: scans for the first valid
 * Layer III frame header within 64 KiB after the ID3v2 tag, then prefers a
 * Xing/Info frame count, else a VBRI frame count, else a CBR estimate from
 * the remaining file size. Returns `null` on any other format or failure.
 * @param {ReadAt} readAt
 * @param {number} audioStart
 * @param {number} fileSize
 * @returns {Promise<number | null>}
 */
export async function readMpegDurationMs(readAt, audioStart, fileSize) {
  if (fileSize <= audioStart) return null;
  const win = await readAt(audioStart, SYNC_WINDOW);
  const found = findFrame(win);
  if (!found) return null;
  const frameStart = audioStart + found.offset;
  const probe = await readAt(frameStart, PROBE_SIZE);
  const frames = tryXingFrames(probe, found.header) ?? tryVbriFrames(probe);
  if (frames !== null) {
    return Math.round((frames * found.header.samplesPerFrame / found.header.sampleRate) * 1000);
  }
  const bitrateBps = found.header.bitrateKbps * 1000;
  return Math.round(((fileSize - audioStart) * 8 / bitrateBps) * 1000);
}

/** Scans a buffer for the first valid MPEG-1/2/2.5 Layer III frame header.
 * @param {Buffer} win @returns {{ offset: number, header: FrameHeader } | null} */
function findFrame(win) {
  for (let i = 0; i + 4 <= win.length; i++) {
    const header = decodeFrameHeader(win[i], win[i + 1], win[i + 2], win[i + 3]);
    if (header) return { offset: i, header };
  }
  return null;
}

/** Decodes 4 candidate header bytes; `null` when not a valid Layer III sync.
 * @param {number} b0 @param {number} b1 @param {number} b2 @param {number} b3 @returns {FrameHeader | null} */
function decodeFrameHeader(b0, b1, b2, b3) {
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
  const versionBits = (b1 >> 3) & 0x3;
  const layerBits = (b1 >> 1) & 0x3;
  if (versionBits === 1 || layerBits !== 1) return null;
  const sampleRateIdx = (b2 >> 2) & 0x3;
  if (sampleRateIdx === 3) return null;
  const bitrateIdx = (b2 >> 4) & 0xf;
  const isV1 = versionBits === 3;
  const bitrateKbps = (isV1 ? BITRATE_L3_V1 : BITRATE_L3_V2)[bitrateIdx];
  if (!bitrateKbps) return null;
  const channelMode = (b3 >> 6) & 0x3;
  return {
    isV1,
    sampleRate: SAMPLE_RATE_TABLE[versionBits][sampleRateIdx],
    bitrateKbps,
    padding: (b2 >> 1) & 0x1,
    channelMode,
    samplesPerFrame: isV1 ? 1152 : 576,
  };
}

/** Side info size in bytes (MPEG version x mono/stereo), per the MPEG audio spec.
 * @param {boolean} isV1 @param {number} channelMode @returns {number} */
function sideInfoSize(isV1, channelMode) {
  const mono = channelMode === 3;
  if (isV1) return mono ? 17 : 32;
  return mono ? 9 : 17;
}

/** Reads the Xing/Info frame count from the probe buffer, when present and it carries one.
 * @param {Buffer} probe @param {FrameHeader} header @returns {number | null} */
function tryXingFrames(probe, header) {
  const tagOffset = 4 + sideInfoSize(header.isV1, header.channelMode);
  if (probe.length < tagOffset + 8) return null;
  const tag = probe.toString('latin1', tagOffset, tagOffset + 4);
  if (tag !== 'Xing' && tag !== 'Info') return null;
  const flags = probe.readUInt32BE(tagOffset + 4);
  if ((flags & 0x1) === 0 || probe.length < tagOffset + 12) return null;
  return probe.readUInt32BE(tagOffset + 8);
}

/** Reads the VBRI frame count from the probe buffer, when a VBRI header is present.
 * VBRI always sits at a fixed offset, independent of the side info size.
 * @param {Buffer} probe @returns {number | null} */
function tryVbriFrames(probe) {
  const vbriOffset = 4 + 32;
  if (probe.length < vbriOffset + 18) return null;
  if (probe.toString('latin1', vbriOffset, vbriOffset + 4) !== 'VBRI') return null;
  return probe.readUInt32BE(vbriOffset + 14);
}
