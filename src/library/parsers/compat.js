// @ts-check

/**
 * The project's single extension/MIME table (D9, spec-library-video.md). Every
 * other module that needs to know whether a file plays in the browser or what
 * MIME type to serve it with (Phase 3's `src/http/media-types.js`) reads this
 * table instead of keeping a second one.
 */

/** @typedef {'video' | 'audio' | 'image'} MediaKind */

/**
 * @typedef {object} CompatEntry
 * @property {MediaKind} kind
 * @property {boolean} playable extension plays in Chromium and Firefox
 *   (subject to the codec sniff for `sniff: true` rows)
 * @property {boolean} sniff true for the MP4-family extensions whose real
 *   codecs must be sniffed before `playable` can be trusted
 * @property {string | null} mime set iff `playable` is true, else `null`
 */

/**
 * @param {MediaKind} kind
 * @param {boolean} sniff
 * @param {string} mime
 * @returns {CompatEntry}
 */
function playable(kind, sniff, mime) {
  return { kind, playable: true, sniff, mime };
}

/**
 * @param {MediaKind} kind
 * @returns {CompatEntry}
 */
function notPlayable(kind) {
  return { kind, playable: false, sniff: false, mime: null };
}

/**
 * Lower-case extension (without the dot) -> compatibility entry. The only
 * extension/MIME table of the project (D9).
 * @type {Readonly<Record<string, CompatEntry>>}
 */
export const EXTENSIONS = Object.freeze({
  // video - playable as-is
  webm: playable('video', false, 'video/webm'),
  // video - playable after the MP4 codec sniff
  mp4: playable('video', true, 'video/mp4'),
  m4v: playable('video', true, 'video/mp4'),
  // video - indexed, not playable
  mkv: notPlayable('video'),
  avi: notPlayable('video'),
  mov: notPlayable('video'),
  wmv: notPlayable('video'),
  flv: notPlayable('video'),
  mpg: notPlayable('video'),
  mpeg: notPlayable('video'),
  ts: notPlayable('video'),
  m2ts: notPlayable('video'),
  mts: notPlayable('video'),
  vob: notPlayable('video'),
  ogv: notPlayable('video'),
  '3gp': notPlayable('video'),
  divx: notPlayable('video'),
  asf: notPlayable('video'),
  rm: notPlayable('video'),
  rmvb: notPlayable('video'),

  // audio - playable as-is
  mp3: playable('audio', false, 'audio/mpeg'),
  aac: playable('audio', false, 'audio/aac'),
  flac: playable('audio', false, 'audio/flac'),
  ogg: playable('audio', false, 'audio/ogg'),
  oga: playable('audio', false, 'audio/ogg'),
  opus: playable('audio', false, 'audio/ogg'),
  weba: playable('audio', false, 'audio/webm'),
  wav: playable('audio', false, 'audio/wav'),
  // audio - playable after the MP4 codec sniff
  m4a: playable('audio', true, 'audio/mp4'),
  m4b: playable('audio', true, 'audio/mp4'),
  // audio - indexed, not playable
  wma: notPlayable('audio'),
  ape: notPlayable('audio'),
  aif: notPlayable('audio'),
  aiff: notPlayable('audio'),
  mka: notPlayable('audio'),
  wv: notPlayable('audio'),
  dsf: notPlayable('audio'),
  dff: notPlayable('audio'),
  ac3: notPlayable('audio'),
  dts: notPlayable('audio'),
  amr: notPlayable('audio'),
  mid: notPlayable('audio'),
  midi: notPlayable('audio'),

  // image - playable as-is
  jpg: playable('image', false, 'image/jpeg'),
  jpeg: playable('image', false, 'image/jpeg'),
  jfif: playable('image', false, 'image/jpeg'),
  png: playable('image', false, 'image/png'),
  gif: playable('image', false, 'image/gif'),
  webp: playable('image', false, 'image/webp'),
  avif: playable('image', false, 'image/avif'),
  bmp: playable('image', false, 'image/bmp'),
  // image - indexed, not playable (svg is script-capable same-origin content,
  // never served by /media/:id even though the browser could render it)
  heic: notPlayable('image'),
  heif: notPlayable('image'),
  tif: notPlayable('image'),
  tiff: notPlayable('image'),
  jxl: notPlayable('image'),
  svg: notPlayable('image'),
  dng: notPlayable('image'),
  cr2: notPlayable('image'),
  cr3: notPlayable('image'),
  nef: notPlayable('image'),
  arw: notPlayable('image'),
  orf: notPlayable('image'),
  rw2: notPlayable('image'),
  raf: notPlayable('image'),
});

/**
 * Integer constant, next to the table it governs. Bump it whenever a change
 * to this table (or to a parser / `categories.js`) changes the result for
 * already-indexed files, so the scanner re-parses them on the next scan.
 */
export const SCAN_VERSION = 1;

/**
 * @param {string} ext lower-case extension without the dot
 * @returns {boolean}
 */
export function isPlayableExtension(ext) {
  return EXTENSIONS[ext]?.playable === true;
}

/**
 * @param {string} ext lower-case extension without the dot
 * @returns {string | null}
 */
export function mimeForExtension(ext) {
  return EXTENSIONS[ext]?.mime ?? null;
}

/** @typedef {{ video: string[], audio: string[] }} SniffedCodecs */

/** Sample-entry fourccs that keep an MP4-family video track playable. */
const SNIFF_VIDEO_OK = new Set(['avc1', 'avc3', 'av01', 'vp09']);

/** Sample-entry fourccs that keep an MP4-family audio track playable. */
const SNIFF_AUDIO_OK = new Set(['mp4a', 'Opus', 'fLaC', '.mp3']);

/**
 * @param {{ ext: string, size: number, codecs: SniffedCodecs | null }} params
 *   `codecs` is the `sniffMp4Codecs` result: `null` when sniffing was not
 *   attempted or the box walk failed ("unknown" -> playable by extension).
 * @returns {boolean} `false` if the extension is not playable or `size` is 0;
 *   for a sniffed row with non-null `codecs` the fourcc rule; otherwise
 *   `true`.
 */
export function resolvePlayable({ ext, size, codecs }) {
  const row = EXTENSIONS[ext];
  if (!row || !row.playable || size === 0) return false;
  if (row.sniff && codecs != null) {
    return (
      codecs.video.every((fourcc) => SNIFF_VIDEO_OK.has(fourcc)) &&
      codecs.audio.every((fourcc) => SNIFF_AUDIO_OK.has(fourcc))
    );
  }
  return true;
}
