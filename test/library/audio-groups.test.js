import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playOrder, buildAlbums, buildArtistSections, buildBooks } from '../../src/library/audio-groups.js';

/** @typedef {import('../../src/library/audio-groups.js').AudioRow} AudioRow */
/** @typedef {import('../../src/library/audio-groups.js').Album} Album */

/**
 * Builds a minimal, fully-populated {@link Album} fixture for
 * {@link buildArtistSections} tests, overridden with only the fields that
 * matter to the section/order rules under test.
 *
 * @param {Partial<Album>} overrides - fields to override.
 * @returns {Album} the album fixture.
 */
function album(overrides) {
  return {
    id: 1,
    coverId: 1,
    groupKey: 'g',
    title: 'Title',
    artist: 'Artist',
    year: null,
    durationMs: null,
    members: [],
    ...overrides,
  };
}

/**
 * Builds a minimal, fully-populated {@link AudioRow} fixture, overridden per
 * test with only the fields that matter to it.
 *
 * @param {Partial<AudioRow>} overrides - fields to override.
 * @returns {AudioRow} the row fixture.
 */
function row(overrides) {
  return {
    id: 1,
    relPath: 'Musik/Artist/Album/01 Title.mp3',
    dir: 'Musik/Artist/Album',
    category: 'music',
    ext: 'mp3',
    playable: true,
    groupKey: 'Musik/Artist/Album',
    groupTitle: 'Album',
    groupArtist: 'Artist',
    title: 'Title',
    trackNo: 1,
    discNo: 1,
    tagArtist: null,
    tagAlbumArtist: null,
    tagAlbum: null,
    tagYear: null,
    durationMs: null,
    ...overrides,
  };
}

test('playOrder: disc ascending, then track ascending', () => {
  const rows = [
    row({ id: 1, discNo: 2, trackNo: 1 }),
    row({ id: 2, discNo: 1, trackNo: 2 }),
    row({ id: 3, discNo: 1, trackNo: 1 }),
  ];
  assert.deepEqual(playOrder(rows).map((r) => r.id), [3, 2, 1]);
});

test('playOrder: unnumbered tracks (trackNo null) sort after numbered ones', () => {
  const rows = [
    row({ id: 1, trackNo: null, relPath: 'a/Zzz.mp3' }),
    row({ id: 2, trackNo: 2 }),
    row({ id: 3, trackNo: 1 }),
  ];
  assert.deepEqual(playOrder(rows).map((r) => r.id), [3, 2, 1]);
});

test('playOrder: falls back to natural filename order, then id', () => {
  const rows = [
    row({ id: 1, trackNo: null, relPath: 'a/10 Track.mp3' }),
    row({ id: 2, trackNo: null, relPath: 'a/2 Track.mp3' }),
    row({ id: 4, trackNo: null, relPath: 'a/Same.mp3' }),
    row({ id: 3, trackNo: null, relPath: 'a/Same.mp3' }),
  ];
  assert.deepEqual(playOrder(rows).map((r) => r.id), [2, 1, 3, 4]);
});

test('playOrder is pure: does not mutate its input array', () => {
  const rows = [row({ id: 2, trackNo: 2 }), row({ id: 1, trackNo: 1 })];
  const original = [...rows];
  playOrder(rows);
  assert.deepEqual(rows, original);
});

test('buildAlbums: real album title/artist/year prefer tags over the folder', () => {
  const rows = [
    row({
      id: 1,
      trackNo: 1,
      tagAlbum: 'Tag Album',
      tagAlbumArtist: 'Tag Album Artist',
      tagYear: 2020,
    }),
  ];
  const [album] = buildAlbums(rows);
  assert.equal(album.title, 'Tag Album');
  assert.equal(album.artist, 'Tag Album Artist');
  assert.equal(album.year, 2020);
});

test('buildAlbums: real album without tags falls back to the folder', () => {
  const rows = [row({ id: 1, groupTitle: 'Folder Album', groupArtist: 'Folder Artist' })];
  const [album] = buildAlbums(rows);
  assert.equal(album.title, 'Folder Album');
  assert.equal(album.artist, 'Folder Artist');
  assert.equal(album.year, null);
});

test('buildAlbums: album-artist fallback chain', () => {
  const sameArtist = buildAlbums([
    row({ id: 1, trackNo: 1, tagArtist: 'X' }),
    row({ id: 2, trackNo: 2, tagArtist: 'X' }),
  ])[0];
  assert.equal(sameArtist.artist, 'X', 'identical non-null tag artist wins over the folder');

  const differingArtist = buildAlbums([
    row({ id: 1, trackNo: 1, tagArtist: 'X', groupArtist: 'Folder' }),
    row({ id: 2, trackNo: 2, tagArtist: 'Y', groupArtist: 'Folder' }),
  ])[0];
  assert.equal(differingArtist.artist, 'Folder', 'differing tag artists fall back to the folder');

  const noneKnown = buildAlbums([row({ id: 1, groupArtist: null })])[0];
  assert.equal(noneKnown.artist, null);

  const albumArtistWins = buildAlbums([
    row({ id: 1, trackNo: 1, tagAlbumArtist: 'AA', tagArtist: 'X' }),
    row({ id: 2, trackNo: 2, tagArtist: 'Y' }),
  ])[0];
  assert.equal(albumArtistWins.artist, 'AA', 'a non-null album-artist wins first, regardless of tag artist');
});

test('buildAlbums: year is the first non-null tag year in play order', () => {
  const [album] = buildAlbums([
    row({ id: 1, trackNo: 1, tagYear: null }),
    row({ id: 2, trackNo: 2, tagYear: 2018 }),
  ]);
  assert.equal(album.year, 2018);
});

test('buildAlbums: pseudo-albums (groupTitle null) ignore tags entirely', () => {
  const rows = [
    row({
      id: 1,
      groupTitle: null,
      groupArtist: 'Loose Folder',
      tagAlbum: 'Should be ignored',
      tagAlbumArtist: 'Should be ignored',
      tagArtist: 'Should be ignored',
      tagYear: 1999,
    }),
  ];
  const [album] = buildAlbums(rows);
  assert.equal(album.title, null);
  assert.equal(album.artist, 'Loose Folder');
  assert.equal(album.year, null);
});

test('buildAlbums: coverId is the first playable member, id is the first member', () => {
  const rows = [
    row({ id: 1, trackNo: 1, playable: false }),
    row({ id: 2, trackNo: 2, playable: true }),
    row({ id: 3, trackNo: 3, playable: true }),
  ];
  const [album] = buildAlbums(rows);
  assert.equal(album.id, 1);
  assert.equal(album.coverId, 2);
});

test('buildAlbums: coverId falls back to id when no member is playable', () => {
  const rows = [
    row({ id: 1, trackNo: 1, playable: false }),
    row({ id: 2, trackNo: 2, playable: false }),
  ];
  const [album] = buildAlbums(rows);
  assert.equal(album.id, 1);
  assert.equal(album.coverId, 1);
});

test('buildAlbums: duration totals sum known members, null when none is known', () => {
  const allUnknown = buildAlbums([
    row({ id: 1, trackNo: 1, durationMs: null }),
    row({ id: 2, trackNo: 2, durationMs: null }),
  ])[0];
  assert.equal(allUnknown.durationMs, null);

  const mixed = buildAlbums([
    row({ id: 1, trackNo: 1, durationMs: 1000 }),
    row({ id: 2, trackNo: 2, durationMs: null }),
    row({ id: 3, trackNo: 3, durationMs: 2000 }),
  ])[0];
  assert.equal(mixed.durationMs, 3000);
});

test('buildAlbums: members are grouped by groupKey and kept in play order', () => {
  const rows = [
    row({ id: 1, groupKey: 'a', trackNo: 2 }),
    row({ id: 2, groupKey: 'b', trackNo: 1 }),
    row({ id: 3, groupKey: 'a', trackNo: 1 }),
  ];
  const albums = buildAlbums(rows);
  assert.equal(albums.length, 2);
  const albumA = albums.find((a) => a.groupKey === 'a');
  assert.ok(albumA);
  assert.deepEqual(albumA.members.map((m) => m.id), [3, 1]);
});

test('buildArtistSections: albums within an artist ordered by year (null last), then title', () => {
  const albums = [
    album({ artist: 'A', title: 'Zeta', year: null }),
    album({ artist: 'A', title: 'Alpha', year: 2010 }),
    album({ artist: 'A', title: 'Beta', year: 2005 }),
  ];
  const [section] = buildArtistSections(albums);
  assert.deepEqual(section.albums.map((a) => a.title), ['Beta', 'Alpha', 'Zeta']);
});

test('buildArtistSections: sections ordered by name (natural), null artist last', () => {
  const albums = [
    album({ artist: null, title: 'Loose', year: null }),
    album({ artist: 'Zebra', title: 'Z1', year: null }),
    album({ artist: 'Album 10', title: 'A1', year: null }),
    album({ artist: 'Album 2', title: 'A2', year: null }),
  ];
  const names = buildArtistSections(albums).map((s) => s.name);
  assert.deepEqual(names, ['Album 2', 'Album 10', 'Zebra', null]);
});

test('buildBooks: title/author are always folder-derived, never from tags', () => {
  const rows = [
    row({
      category: 'audiobooks',
      groupTitle: 'Der Titel',
      groupArtist: 'Die Autorin',
      tagAlbum: 'Ignored',
      tagAlbumArtist: 'Ignored',
    }),
  ];
  const [book] = buildBooks(rows);
  assert.equal(book.title, 'Der Titel');
  assert.equal(book.author, 'Die Autorin');
});

test('buildBooks: file titles keep the row-resolved title untouched', () => {
  const rows = [row({ category: 'audiobooks', title: 'Kapitel 1 (resolved)' })];
  const [book] = buildBooks(rows);
  assert.equal(book.members[0].title, 'Kapitel 1 (resolved)');
});

test('buildBooks: ordered by title then author, null author last', () => {
  const books = buildBooks([
    row({ id: 1, groupKey: 'a', category: 'audiobooks', groupTitle: 'Buch B', groupArtist: null }),
    row({ id: 2, groupKey: 'b', category: 'audiobooks', groupTitle: 'Buch A', groupArtist: 'Zora' }),
    row({ id: 3, groupKey: 'c', category: 'audiobooks', groupTitle: 'Buch A', groupArtist: 'Anna' }),
  ]);
  assert.deepEqual(
    books.map((b) => [b.title, b.author]),
    [
      ['Buch A', 'Anna'],
      ['Buch A', 'Zora'],
      ['Buch B', null],
    ],
  );
});

test('buildBooks: coverId/id and duration totals follow the same rules as albums', () => {
  const rows = [
    row({ id: 1, category: 'audiobooks', trackNo: 1, playable: false, durationMs: null }),
    row({ id: 2, category: 'audiobooks', trackNo: 2, playable: true, durationMs: 1500 }),
  ];
  const [book] = buildBooks(rows);
  assert.equal(book.id, 1);
  assert.equal(book.coverId, 2);
  assert.equal(book.durationMs, 1500);
});
