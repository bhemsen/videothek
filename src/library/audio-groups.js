/**
 * @typedef {{ id: number, relPath: string, dir: string, category: ('music'|'audiobooks'), ext: string, playable: (boolean|number), groupKey: string, groupTitle: (string|null), groupArtist: (string|null), title: string, trackNo: (number|null), discNo: number, tagArtist: (string|null), tagAlbumArtist: (string|null), tagAlbum: (string|null), tagYear: (number|null), durationMs: (number|null) }} AudioRow
 * @typedef {{ id: number, coverId: number, groupKey: string, title: (string|null), artist: (string|null), year: (number|null), durationMs: (number|null), members: AudioRow[] }} Album
 * @typedef {{ name: (string|null), albums: Album[] }} ArtistSection
 * @typedef {{ id: number, coverId: number, groupKey: string, title: string, author: (string|null), durationMs: (number|null), members: AudioRow[] }} Book
 */

// One shared natural-order collator for filenames, titles and artist/author
// names ("Play order" decision: "the same collator").
const COLLATOR = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

/**
 * Orders the rows of one group (album or book) in play order: disc number
 * ascending, then track number ascending with unnumbered tracks last, then
 * the on-disk filename in natural order, then item id as a final,
 * deterministic tiebreaker. Pure — returns a new array, never mutates
 * `rows`.
 *
 * @param {AudioRow[]} rows - joined audio rows of a single group.
 * @returns {AudioRow[]} the rows sorted into play order.
 */
export function playOrder(rows) {
  return [...rows].sort(compareRows);
}

/**
 * Assembles music rows into albums per the "Music precedence" and "Group
 * ids" rules: title/artist/year are resolved from the first member in play
 * order for a real album (a non-null `groupTitle`); a pseudo-album (loose
 * tracks, `groupTitle` null) ignores tags entirely for its own display.
 * Pure — `rows` is expected to already be filtered to one category by the
 * caller (e.g. `listAudioRows(db, 'music')`); grouping order is otherwise
 * unspecified (use {@link buildArtistSections} for display order).
 *
 * @param {AudioRow[]} rows - joined `music` rows.
 * @returns {Album[]} the assembled albums.
 */
export function buildAlbums(rows) {
  const albums = [];
  for (const groupRows of groupByKey(rows).values()) {
    const members = playOrder(groupRows);
    const first = members[0];
    const pseudo = first.groupTitle == null;
    albums.push({
      id: first.id,
      coverId: resolveCoverId(members),
      groupKey: first.groupKey,
      title: pseudo ? null : (first.tagAlbum ?? first.groupTitle),
      artist: pseudo ? first.groupArtist : resolveAlbumArtist(members),
      year: pseudo ? null : resolveAlbumYear(members),
      durationMs: sumKnownDurations(members),
      members,
    });
  }
  return albums;
}

/**
 * Groups albums into artist sections per the "Play order" rules: albums
 * grouped by their resolved `artist` (exact match; `null` — unknown artist —
 * groups together), each section's albums ordered by year ascending (`null`
 * last) then title in natural order (`null` last), and the sections
 * themselves ordered by name in natural order with `null` sorted last.
 *
 * @param {Album[]} albums - albums as built by {@link buildAlbums}.
 * @returns {ArtistSection[]} artist sections, fully ordered.
 */
export function buildArtistSections(albums) {
  const groups = new Map();
  for (const album of albums) {
    addToGroup(groups, album.artist, album);
  }
  const sections = [...groups.entries()].map(([name, groupAlbums]) => ({
    name,
    albums: [...groupAlbums].sort(compareAlbumsWithinArtist),
  }));
  return sections.sort((a, b) => compareNullableString(a.name, b.name));
}

/**
 * Assembles audiobook rows into books per the "Audiobook precedence" and
 * "Group ids" rules: title and author are always folder-derived
 * (`groupTitle`/`groupArtist`) — file titles keep whatever tag precedence is
 * already resolved on each row. Books are ordered by title then author, both
 * in natural order with `null` author sorted last (`groupTitle` of a book is
 * never null). Pure — `rows` is expected to already be filtered to one
 * category by the caller.
 *
 * @param {AudioRow[]} rows - joined `audiobooks` rows.
 * @returns {Book[]} books, ordered by title then author.
 */
export function buildBooks(rows) {
  const books = [];
  for (const groupRows of groupByKey(rows).values()) {
    const members = playOrder(groupRows);
    const first = members[0];
    books.push({
      id: first.id,
      coverId: resolveCoverId(members),
      groupKey: first.groupKey,
      // A book's `groupTitle` is never null (Parser interfaces decision).
      title: /** @type {string} */ (first.groupTitle),
      author: first.groupArtist,
      durationMs: sumKnownDurations(members),
      members,
    });
  }
  return books.sort(compareBooks);
}

/**
 * Compares two rows for play order (see {@link playOrder}).
 *
 * @param {AudioRow} a - the first row.
 * @param {AudioRow} b - the second row.
 * @returns {number} sort order per `Array#sort` convention.
 */
function compareRows(a, b) {
  if (a.discNo !== b.discNo) return a.discNo - b.discNo;
  const track = compareNullableNumber(a.trackNo, b.trackNo);
  if (track !== 0) return track;
  const name = COLLATOR.compare(basename(a.relPath), basename(b.relPath));
  if (name !== 0) return name;
  return a.id - b.id;
}

/**
 * Last path segment of a relative path (`/` or `\` separated).
 *
 * @param {string} relPath - a relative path.
 * @returns {string} the filename.
 */
function basename(relPath) {
  const segments = relPath.split(/[/\\]/);
  return segments[segments.length - 1];
}

/**
 * Compares two nullable numbers ascending; `null` sorts after every number.
 *
 * @param {number|null} a - the first value.
 * @param {number|null} b - the second value.
 * @returns {number} sort order per `Array#sort` convention.
 */
function compareNullableNumber(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return a - b;
}

/**
 * Compares two nullable strings via the shared natural-order `COLLATOR`;
 * `null` sorts after every non-null value.
 *
 * @param {string|null} a - the first value.
 * @param {string|null} b - the second value.
 * @returns {number} sort order per `Array#sort` convention.
 */
function compareNullableString(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return COLLATOR.compare(a, b);
}

/**
 * Groups rows by their `groupKey`, preserving each group's row order.
 *
 * @param {AudioRow[]} rows - joined audio rows of one category.
 * @returns {Map<string, AudioRow[]>} rows grouped by `groupKey`.
 */
function groupByKey(rows) {
  const groups = new Map();
  for (const row of rows) {
    addToGroup(groups, row.groupKey, row);
  }
  return groups;
}

/**
 * Appends a value to its group in a `Map<key, value[]>`, creating the group
 * on first use.
 *
 * @template K, V
 * @param {Map<K, V[]>} groups - the map of groups to append to.
 * @param {K} key - the group key.
 * @param {V} value - the value to append.
 * @returns {void}
 */
function addToGroup(groups, key, value) {
  const group = groups.get(key);
  if (group) {
    group.push(value);
  } else {
    groups.set(key, [value]);
  }
}

/**
 * A group's cover id: the first playable member in play order, or the group
 * id (its first member) when no member is playable.
 *
 * @param {AudioRow[]} members - a group's rows, already in play order.
 * @returns {number} the resolved cover id.
 */
function resolveCoverId(members) {
  const playable = members.find((member) => Boolean(member.playable));
  return playable ? playable.id : members[0].id;
}

/**
 * Sums the known member durations of a group, ignoring members whose
 * duration is unknown; `null` when none of them is known.
 *
 * @param {AudioRow[]} members - a group's rows.
 * @returns {number|null} the summed duration in milliseconds, or `null`.
 */
function sumKnownDurations(members) {
  let total = null;
  for (const member of members) {
    if (member.durationMs != null) {
      total = (total ?? 0) + member.durationMs;
    }
  }
  return total;
}

/**
 * A real album's artist per the "Music precedence" fallback chain: the first
 * member's tag album-artist, else its tag artist when every member shares
 * that same non-null tag artist, else the folder-derived group artist, else
 * `null`.
 *
 * @param {AudioRow[]} members - the album's rows, in play order.
 * @returns {string|null} the resolved artist, or `null` when unknown.
 */
function resolveAlbumArtist(members) {
  const first = members[0];
  if (first.tagAlbumArtist != null) return first.tagAlbumArtist;
  if (first.tagArtist != null && members.every((member) => member.tagArtist === first.tagArtist)) {
    return first.tagArtist;
  }
  return first.groupArtist ?? null;
}

/**
 * A real album's year: the first non-null tag year among its members in
 * play order.
 *
 * @param {AudioRow[]} members - the album's rows, in play order.
 * @returns {number|null} the resolved year, or `null` when none is tagged.
 */
function resolveAlbumYear(members) {
  for (const member of members) {
    if (member.tagYear != null) return member.tagYear;
  }
  return null;
}

/**
 * Compares two albums of the same artist section: year ascending (`null`
 * last), then title in natural order (`null` last).
 *
 * @param {Album} a - the first album.
 * @param {Album} b - the second album.
 * @returns {number} sort order per `Array#sort` convention.
 */
function compareAlbumsWithinArtist(a, b) {
  const year = compareNullableNumber(a.year, b.year);
  if (year !== 0) return year;
  return compareNullableString(a.title, b.title);
}

/**
 * Compares two books by title, then author, both in natural order with
 * `null` sorted last.
 *
 * @param {Book} a - the first book.
 * @param {Book} b - the second book.
 * @returns {number} sort order per `Array#sort` convention.
 */
function compareBooks(a, b) {
  const title = compareNullableString(a.title, b.title);
  if (title !== 0) return title;
  return compareNullableString(a.author, b.author);
}
