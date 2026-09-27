// @ts-check
/**
 * Deterministic generator for the committed synthetic Musik/Hörbücher tree
 * under `test/fixtures/media/` (`Musik/**`, `Hörbücher/**`), plus a `--bulk`
 * mode for the idle-RSS QA line. Built entirely from the ID3v2/MPEG and FLAC
 * fixture builders — never a real media file. Every path segment written is
 * NFC-normalised, so regenerating this tree reproduces it byte for byte.
 *
 * CLI: `node test/helpers/make-audio-fixtures.js <mediaRoot>` (writes the
 * committed tree) or `node test/helpers/make-audio-fixtures.js --bulk <n>
 * <dir>` (writes `n` synthetic tracks for perf/idle-RSS QA, not committed).
 *
 * @see docs/specs/spec-music-audiobooks.md — "Fixtures" decision-log row.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { ENCODING, buildId3v2Tag, buildFrame, textFrameBody, apicFrameBody, buildMpegFrame } from './mp3-fixture.js';
import { buildFlacFile } from './flac-fixture.js';

const SAMPLE_RATE = 32000; // matches mp3-fixture.js's fixture standard (32 kHz, 32 kbit/s, mono)
const SAMPLES_PER_FRAME = 1152;
const BULK_TRACK_SECONDS = 2;
const BULK_TRACKS_PER_ALBUM = 10;
const BULK_ALBUMS_PER_ARTIST = 10;
const BULK_APIC_BYTES = 256 * 1024;

/** Number of MPEG frames needed for a given duration at the fixture standard rate.
 * @param {number} seconds @returns {number} */
function framesFor(seconds) {
  return Math.round((seconds * SAMPLE_RATE) / SAMPLES_PER_FRAME);
}

/** Writes `data` at `root/<segments>`, NFC-normalising every segment, creating parent dirs.
 * @param {string} root @param {string[]} segments @param {Buffer} data @returns {void} */
function writeFixtureFile(root, segments, data) {
  const rel = segments.map((s) => s.normalize('NFC'));
  const abs = path.join(root, ...rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
}

/** One length-prefixed, CRC-suffixed PNG chunk. @param {string} type @param {Buffer} data @returns {Buffer} */
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** A small flat-colour truecolor PNG, built with `node:zlib` (`deflateSync`, `crc32`).
 * @param {number} size @param {[number, number, number]} rgb @returns {Buffer} */
function makeCoverPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size * 3 }, (_, i) => [r, g, b][i % 3]))]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

/**
 * Builds a synthetic MP3 file: an optional ID3v2.4 tag (text fields plus an
 * optional embedded front-cover APIC) followed by silent CBR frames.
 * @param {{ seconds: number, fields?: Record<string, string>, cover?: Buffer }} opts
 * @returns {Buffer}
 */
function buildMp3({ seconds, fields, cover }) {
  const frames = Object.entries(fields ?? {}).map(([id, value]) =>
    buildFrame({ id, body: textFrameBody(ENCODING.UTF8, value.normalize('NFC')) }));
  if (cover) frames.push(buildFrame({ id: 'APIC', body: apicFrameBody({ encoding: ENCODING.UTF8, mime: 'image/png', data: cover }) }));
  const tag = fields || cover ? buildId3v2Tag({ frames }) : Buffer.alloc(0);
  const audio = Buffer.concat(Array.from({ length: framesFor(seconds) }, () => buildMpegFrame()));
  return Buffer.concat([tag, audio]);
}

/**
 * Builds a synthetic FLAC file: STREAMINFO/VORBIS_COMMENT/optional PICTURE
 * plus silent CONSTANT-subframe frames.
 * @param {{ seconds: number, comments: Record<string, string>, cover?: Buffer }} opts
 * @returns {Buffer}
 */
function buildFlacTrack({ seconds, comments, cover }) {
  return buildFlacFile({
    sampleRate: 44100,
    channels: 1,
    bitsPerSample: 16,
    totalSamples: Math.round(seconds * 44100),
    vorbisComments: comments,
    pictures: cover ? [{ type: 3, mime: 'image/png', data: cover }] : [],
  });
}

/** `Musik/Die Beispiele/Unterwegs/`: 3 tagged 120 s tracks with an embedded cover.
 * @param {string} root @returns {void} */
function buildUnterwegs(root) {
  const cover = makeCoverPng(8, [230, 120, 40]);
  const titles = ['Aufbruch', 'Mittendrin', 'Ankunft'];
  titles.forEach((title, i) => {
    const trackNo = String(i + 1);
    const fields = { TIT2: title, TPE1: 'Die Beispiele', TPE2: 'Die Beispiele', TALB: 'Unterwegs', TRCK: trackNo, TDRC: '2021' };
    const file = buildMp3({ seconds: 120, fields, cover });
    writeFixtureFile(root, ['Musik', 'Die Beispiele', 'Unterwegs', `0${trackNo} ${title}.mp3`], file);
  });
}

/** `Musik/Die Beispiele/Doppelalbum/CD 1|CD 2/`: 6 tagged 60 s tracks, one folder `cover.png`.
 * @param {string} root @returns {void} */
function buildDoppelalbum(root) {
  const discs = [
    { dir: 'CD 1', titles: ['Erster Teil', 'Zweiter Teil', 'Dritter Teil'], disc: 1 },
    { dir: 'CD 2', titles: ['Vierter Teil', 'Fünfter Teil', 'Sechster Teil'], disc: 2 },
  ];
  for (const { dir, titles, disc } of discs) {
    titles.forEach((title, i) => {
      const trackNo = String(i + 1);
      const fields = { TIT2: title, TPE2: 'Die Beispiele', TALB: 'Doppelalbum', TRCK: trackNo, TPOS: String(disc), TDRC: '2018' };
      const file = buildMp3({ seconds: 60, fields });
      writeFixtureFile(root, ['Musik', 'Die Beispiele', 'Doppelalbum', dir, `0${trackNo} ${title}.mp3`], file);
    });
  }
  writeFixtureFile(root, ['Musik', 'Die Beispiele', 'Doppelalbum', 'cover.png'], makeCoverPng(8, [60, 80, 200]));
}

/** `Musik/Unbekannt/Ohne Tags/`: 3 untagged 60 s tracks, filename-numbered.
 * @param {string} root @returns {void} */
function buildOhneTags(root) {
  const names = ['Erste Spur', 'Zweite Spur', 'Dritte Spur'];
  names.forEach((name, i) => {
    const file = buildMp3({ seconds: 60 });
    writeFixtureFile(root, ['Musik', 'Unbekannt', 'Ohne Tags', `0${i + 1} ${name}.mp3`], file);
  });
}

/** `Musik/Klangwerk/Flac Album/`: 3 tagged FLAC tracks with an embedded PICTURE,
 * plus a dummy, non-playable `.wma` bonus track. @param {string} root @returns {void} */
function buildFlacAlbum(root) {
  const cover = makeCoverPng(8, [40, 160, 90]);
  const titles = ['Anfang', 'Mitte', 'Ende'];
  titles.forEach((title, i) => {
    const trackNo = String(i + 1);
    const comments = { TITLE: title, ARTIST: 'Klangwerk', ALBUM: 'Flac Album', TRACKNUMBER: trackNo, DATE: '2022' };
    const file = buildFlacTrack({ seconds: 60, comments, cover });
    writeFixtureFile(root, ['Musik', 'Klangwerk', 'Flac Album', `0${trackNo} ${title}.flac`], file);
  });
  // A leading NUL byte keeps this git-classified as binary, so no platform ever
  // rewrites its line endings (the committed tree must stay byte-identical).
  const dummy = Buffer.concat([Buffer.from([0x00]), Buffer.from('NICHT ABSPIELBARE TESTDATEI – VIDEOTHEK FIXTURE\n'.repeat(40), 'utf8')]);
  writeFixtureFile(root, ['Musik', 'Klangwerk', 'Flac Album', '04 Bonus (Live).wma'], dummy);
}

/** `Musik/Einzeltrack.mp3`: one loose, untagged 60 s track at the category root.
 * @param {string} root @returns {void} */
function buildEinzeltrack(root) {
  writeFixtureFile(root, ['Musik', 'Einzeltrack.mp3'], buildMp3({ seconds: 60 }));
}

/** `Hörbücher/Jules Beispiel/Die Reise/`: 3 tagged files of ≥ 180 s each.
 * @param {string} root @returns {void} */
function buildDieReise(root) {
  const titles = ['Der Aufbruch', 'Mitten im Sturm', 'Die Ankunft'];
  titles.forEach((title, i) => {
    const file = buildMp3({ seconds: 185, fields: { TIT2: title } });
    writeFixtureFile(root, ['Hörbücher', 'Jules Beispiel', 'Die Reise', `0${i + 1} ${title}.mp3`], file);
  });
}

/** `Hörbücher/Jules Beispiel/Kurzgeschichte.mp3`: single-file book with an embedded cover.
 * @param {string} root @returns {void} */
function buildKurzgeschichte(root) {
  const cover = makeCoverPng(8, [180, 60, 150]);
  const file = buildMp3({ seconds: 90, fields: { TIT2: 'Die Kurzgeschichte' }, cover });
  writeFixtureFile(root, ['Hörbücher', 'Jules Beispiel', 'Kurzgeschichte.mp3'], file);
}

/** `Hörbücher/Anna Autorin/Langes Buch/CD 1|CD 2/`: 4 untagged files across two discs.
 * @param {string} root @returns {void} */
function buildLangesBuch(root) {
  const discs = [
    { dir: 'CD 1', names: ['Kapitel eins', 'Kapitel zwei'] },
    { dir: 'CD 2', names: ['Kapitel drei', 'Kapitel vier'] },
  ];
  for (const { dir, names } of discs) {
    names.forEach((name, i) => {
      const file = buildMp3({ seconds: 90 });
      writeFixtureFile(root, ['Hörbücher', 'Anna Autorin', 'Langes Buch', dir, `0${i + 1} ${name}.mp3`], file);
    });
  }
}

/** Writes the whole committed Musik/Hörbücher tree at `mediaRoot`.
 * @param {string} mediaRoot @returns {void} */
export function buildFixtureTree(mediaRoot) {
  for (const build of [buildUnterwegs, buildDoppelalbum, buildOhneTags, buildFlacAlbum, buildEinzeltrack, buildDieReise, buildKurzgeschichte, buildLangesBuch]) {
    build(mediaRoot);
  }
}

/**
 * Writes `n` deterministic, ID3v2.4-tagged 2 s tracks under
 * `<dir>/Musik/Bulk Interpret <a>/Album <b>/<NN> Titel <NN>.mp3` (10 tracks
 * per album, 10 albums per artist); each album's first track carries a
 * 256 KiB embedded APIC, exercising the tag reader's read budget. Not
 * committed — for the perf/idle-RSS QA line.
 * @param {number} n @param {string} dir @returns {void}
 */
export function buildBulkFixtures(n, dir) {
  const apic = Buffer.alloc(BULK_APIC_BYTES, 0xab);
  for (let trackIndex = 0; trackIndex < n; trackIndex++) {
    const albumIndex = Math.floor(trackIndex / BULK_TRACKS_PER_ALBUM);
    const artist = Math.floor(albumIndex / BULK_ALBUMS_PER_ARTIST) + 1;
    const album = (albumIndex % BULK_ALBUMS_PER_ARTIST) + 1;
    const trackNo = (trackIndex % BULK_TRACKS_PER_ALBUM) + 1;
    const nn = String(trackNo).padStart(2, '0');
    const fields = { TIT2: `Titel ${nn}`, TPE1: `Bulk Interpret ${artist}`, TALB: `Album ${album}`, TRCK: String(trackNo) };
    const file = buildMp3({ seconds: BULK_TRACK_SECONDS, fields, cover: trackNo === 1 ? apic : undefined });
    writeFixtureFile(dir, ['Musik', `Bulk Interpret ${artist}`, `Album ${album}`, `${nn} Titel ${nn}.mp3`], file);
  }
}

/** True when this module was invoked directly as the CLI entry point.
 * @returns {boolean} */
function isMainModule() {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--bulk') {
    buildBulkFixtures(Number(args[1]), args[2]);
  } else {
    buildFixtureTree(args[0]);
  }
}

if (isMainModule()) main();
