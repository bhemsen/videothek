import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAudiobookPath } from '../../../src/library/parsers/audiobook.js';

/** @type {Array<{ name: string, relPath: string, expected: object }>} */
const cases = [
  {
    name: 'multi-file book: Author/Book/NN Title.ext',
    relPath: 'Hörbücher/Jules Beispiel/Die Reise/01 Kapitel Eins.mp3',
    expected: {
      groupKey: 'Hörbücher/Jules Beispiel/Die Reise',
      groupTitle: 'Die Reise',
      groupArtist: 'Jules Beispiel',
      fileTitle: 'Kapitel Eins',
      fileTrackNo: 1,
      folderDiscNo: null,
    },
  },
  {
    name: 'disc-folder rollup inside a multi-file book',
    relPath: 'Hörbücher/Anna Autorin/Langes Buch/CD 1/01 Teil.mp3',
    expected: {
      groupKey: 'Hörbücher/Anna Autorin/Langes Buch',
      groupTitle: 'Langes Buch',
      groupArtist: 'Anna Autorin',
      fileTitle: 'Teil',
      fileTrackNo: 1,
      folderDiscNo: 1,
    },
  },
  {
    name: 'single-file book inside an author folder: file is the book',
    relPath: 'Hörbücher/Jules Beispiel/Kurzgeschichte.mp3',
    expected: {
      groupKey: 'Hörbücher/Jules Beispiel/Kurzgeschichte.mp3',
      groupTitle: 'Kurzgeschichte',
      groupArtist: 'Jules Beispiel',
      fileTitle: 'Kurzgeschichte',
      fileTrackNo: null,
      folderDiscNo: null,
    },
  },
  {
    name: 'single-file book at the category root: no author',
    relPath: 'Hörbücher/Standalone.mp3',
    expected: {
      groupKey: 'Hörbücher/Standalone.mp3',
      groupTitle: 'Standalone',
      groupArtist: null,
      fileTitle: 'Standalone',
      fileTrackNo: null,
      folderDiscNo: null,
    },
  },
  {
    name: 'Author/Series/Book: series folder ignored for grouping',
    relPath: 'Hörbücher/Autor/Serie/Buch/01 Teil.mp3',
    expected: {
      groupKey: 'Hörbücher/Autor/Serie/Buch',
      groupTitle: 'Buch',
      groupArtist: 'Autor',
      fileTitle: 'Teil',
      fileTrackNo: 1,
      folderDiscNo: null,
    },
  },
  {
    name: 'single-file book title keeps its leading number (no stripping), unlike fileTitle',
    relPath: 'Hörbücher/Autor/01 Mein Buch.mp3',
    expected: {
      groupKey: 'Hörbücher/Autor/01 Mein Buch.mp3',
      groupTitle: '01 Mein Buch',
      groupArtist: 'Autor',
      fileTitle: 'Mein Buch',
      fileTrackNo: 1,
      folderDiscNo: null,
    },
  },
  {
    name: 'underscore rule applies to a single-file book title when the stem has no space',
    relPath: 'Hörbücher/Mein_Hoerspiel.mp3',
    expected: {
      groupKey: 'Hörbücher/Mein_Hoerspiel.mp3',
      groupTitle: 'Mein Hoerspiel',
      groupArtist: null,
      fileTitle: 'Mein Hoerspiel',
      fileTrackNo: null,
      folderDiscNo: null,
    },
  },
  {
    name: 'alias category folder "Hoerbuecher/" is treated structurally, not by name',
    relPath: 'Hoerbuecher/Jules Beispiel/Die Reise/01 Kapitel Eins.mp3',
    expected: {
      groupKey: 'Hoerbuecher/Jules Beispiel/Die Reise',
      groupTitle: 'Die Reise',
      groupArtist: 'Jules Beispiel',
      fileTitle: 'Kapitel Eins',
      fileTrackNo: 1,
      folderDiscNo: null,
    },
  },
];

for (const { name, relPath, expected } of cases) {
  test(`parseAudiobookPath: ${name}`, () => {
    assert.deepEqual(parseAudiobookPath(relPath), expected);
  });
}

test('parseAudiobookPath: a multi-file book without an author folder appears as single-file books (documented convention)', () => {
  const first = parseAudiobookPath('Hörbücher/LooseBookFolder/01 Teil.mp3');
  const second = parseAudiobookPath('Hörbücher/LooseBookFolder/02 Teil.mp3');

  // Depth 1 (one folder, no author level) means each file is its own book:
  // groupKey is the file's own path, so the two files never share a group.
  assert.equal(first.groupKey, 'Hörbücher/LooseBookFolder/01 Teil.mp3');
  assert.equal(second.groupKey, 'Hörbücher/LooseBookFolder/02 Teil.mp3');
  assert.notEqual(first.groupKey, second.groupKey);
  assert.equal(first.groupArtist, 'LooseBookFolder');
  assert.equal(second.groupArtist, 'LooseBookFolder');
});

test('parseAudiobookPath: display strings are NFC-normalised, groupKey keeps the on-disk form', () => {
  const decomposedAuthor = 'Ärzte'; // "Ärzte" as NFD (combining diaeresis)
  const relPath = `Hörbücher/${decomposedAuthor}/Buch/01 Teil.mp3`;
  const result = parseAudiobookPath(relPath);

  assert.equal(result.groupArtist, 'Ärzte');
  assert.equal(result.groupArtist, 'Ärzte'.normalize('NFC'));
  assert.equal(result.groupKey, `Hörbücher/${decomposedAuthor}/Buch`);
  assert.notEqual(result.groupKey, `Hörbücher/${'Ärzte'.normalize('NFC')}/Buch`);
});

test('parseAudiobookPath: groupTitle is never null, even for a root single-file book', () => {
  const result = parseAudiobookPath('Hörbücher/Standalone.mp3');
  assert.equal(typeof result.groupTitle, 'string');
});
