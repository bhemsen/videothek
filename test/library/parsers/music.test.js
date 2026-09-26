import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMusicPath } from '../../../src/library/parsers/music.js';

/** @type {Array<{ name: string, relPath: string, expected: object }>} */
const cases = [
  {
    name: 'real album: Artist/Album/NN Title.ext',
    relPath: 'Musik/Die Beispiele/Unterwegs/01 Song Eins.mp3',
    expected: {
      groupKey: 'Musik/Die Beispiele/Unterwegs',
      groupTitle: 'Unterwegs',
      groupArtist: 'Die Beispiele',
      fileTitle: 'Song Eins',
      fileTrackNo: 1,
      folderDiscNo: null,
    },
  },
  {
    name: 'disc-folder rollup: "CD 2" removed once, becomes folderDiscNo',
    relPath: 'Musik/Klangwerk/Doppelalbum/CD 2/03 Titel.flac',
    expected: {
      groupKey: 'Musik/Klangwerk/Doppelalbum',
      groupTitle: 'Doppelalbum',
      groupArtist: 'Klangwerk',
      fileTitle: 'Titel',
      fileTrackNo: 3,
      folderDiscNo: 2,
    },
  },
  {
    name: 'disc folder is case-insensitive and space-optional ("disk07")',
    relPath: 'Musik/Klangwerk/Album/disk07/01 Titel.mp3',
    expected: {
      groupKey: 'Musik/Klangwerk/Album',
      groupTitle: 'Album',
      groupArtist: 'Klangwerk',
      fileTitle: 'Titel',
      fileTrackNo: 1,
      folderDiscNo: 7,
    },
  },
  {
    name: 'disc folder variant "Disc 10" (two-digit number)',
    relPath: 'Musik/Klangwerk/Album/Disc 10/01 Titel.mp3',
    expected: {
      groupKey: 'Musik/Klangwerk/Album',
      groupTitle: 'Album',
      groupArtist: 'Klangwerk',
      fileTitle: 'Titel',
      fileTrackNo: 1,
      folderDiscNo: 10,
    },
  },
  {
    name: 'loose tracks at depth 1: pseudo-album, groupTitle null',
    relPath: 'Musik/Einzelinterpret/01 Nur ein Track.mp3',
    expected: {
      groupKey: 'Musik/Einzelinterpret',
      groupTitle: null,
      groupArtist: 'Einzelinterpret',
      fileTitle: 'Nur ein Track',
      fileTrackNo: 1,
      folderDiscNo: null,
    },
  },
  {
    name: 'loose track at depth 0: root pseudo-album, both null',
    relPath: 'Musik/Einzeltrack.mp3',
    expected: {
      groupKey: 'Musik',
      groupTitle: null,
      groupArtist: null,
      fileTitle: 'Einzeltrack',
      fileTrackNo: null,
      folderDiscNo: null,
    },
  },
  {
    name: 'Artist/Year/Album layout: middle segment ignored for grouping',
    relPath: 'Musik/Klangwerk/2020/Flac Album/04 Bonus (Live).wma',
    expected: {
      groupKey: 'Musik/Klangwerk/2020/Flac Album',
      groupTitle: 'Flac Album',
      groupArtist: 'Klangwerk',
      fileTitle: 'Bonus (Live)',
      fileTrackNo: 4,
      folderDiscNo: null,
    },
  },
  {
    name: 'filename without a leading number: no track number stripped',
    relPath: 'Musik/Klangwerk/Album/Track Ohne Nummer.mp3',
    expected: {
      groupKey: 'Musik/Klangwerk/Album',
      groupTitle: 'Album',
      groupArtist: 'Klangwerk',
      fileTitle: 'Track Ohne Nummer',
      fileTrackNo: null,
      folderDiscNo: null,
    },
  },
  {
    name: 'underscore rule applies when the stem has no space',
    relPath: 'Musik/Klangwerk/Album/01_Mein_Song.mp3',
    expected: {
      groupKey: 'Musik/Klangwerk/Album',
      groupTitle: 'Album',
      groupArtist: 'Klangwerk',
      fileTitle: 'Mein Song',
      fileTrackNo: 1,
      folderDiscNo: null,
    },
  },
  {
    name: 'underscore is kept when the stem already contains a space',
    relPath: 'Musik/Klangwerk/Album/01 Mein_Song.mp3',
    expected: {
      groupKey: 'Musik/Klangwerk/Album',
      groupTitle: 'Album',
      groupArtist: 'Klangwerk',
      fileTitle: 'Mein_Song',
      fileTrackNo: 1,
      folderDiscNo: null,
    },
  },
  {
    name: 'alias category folder "Music/" is treated structurally, not by name',
    relPath: 'Music/Die Beispiele/Unterwegs/01 Song Eins.mp3',
    expected: {
      groupKey: 'Music/Die Beispiele/Unterwegs',
      groupTitle: 'Unterwegs',
      groupArtist: 'Die Beispiele',
      fileTitle: 'Song Eins',
      fileTrackNo: 1,
      folderDiscNo: null,
    },
  },
];

for (const { name, relPath, expected } of cases) {
  test(`parseMusicPath: ${name}`, () => {
    assert.deepEqual(parseMusicPath(relPath), expected);
  });
}

test('parseMusicPath: display strings are NFC-normalised, groupKey keeps the on-disk form', () => {
  const decomposedArtist = 'Ärzte'; // "Ärzte" as NFD (combining diaeresis)
  const relPath = `Musik/${decomposedArtist}/Album/01 Titel.mp3`;
  const result = parseMusicPath(relPath);

  assert.equal(result.groupArtist, 'Ärzte');
  assert.equal(result.groupArtist, 'Ärzte'.normalize('NFC'));
  assert.equal(result.groupKey, `Musik/${decomposedArtist}/Album`);
  assert.notEqual(result.groupKey, `Musik/${'Ärzte'.normalize('NFC')}/Album`);
});

test('parseMusicPath: empty cleaned title falls back to the raw stem', () => {
  // stem "12  " (two trailing spaces): the numbered-stem match captures a
  // single space as the title, which trims to empty, so the raw stem wins.
  const result = parseMusicPath('Musik/Klangwerk/Album/12  .mp3');
  assert.equal(result.fileTrackNo, 12);
  assert.equal(result.fileTitle, '12  ');
});
