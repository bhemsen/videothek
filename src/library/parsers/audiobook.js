/**
 * Pure folder-convention parser for audiobook items: no I/O, no imports from
 * `src/db` or `src/http`. The category folder segment (any of its aliases,
 * e.g. "Hörbücher" / "Hoerbuecher" / "Audiobooks") is used only
 * structurally — its name is never matched — so alias resolution stays
 * Phase 2's concern.
 *
 * Spec: docs/specs/spec-music-audiobooks.md — "Audiobook folder convention"
 * and "Filename cleaning" decision-log rows.
 */

const DISC_FOLDER_RE = /^(cd|disc|disk)\s*(\d+)$/i;
const NUMBERED_STEM_RE = /^(\d{1,3})[\s._-]+(.+)$/;

/**
 * @typedef {object} ParsedAudiobookPath
 * @property {string} groupKey rel path of the book directory, or of the file itself for a single-file book (exact on-disk form)
 * @property {string} groupTitle book title — the folder name, or the cleaned filename for a single-file book; never null
 * @property {string|null} groupArtist author folder name; null only when there is no author folder
 * @property {string} fileTitle cleaned, NFC-normalised file title
 * @property {number|null} fileTrackNo track number parsed from the filename
 * @property {number|null} folderDiscNo disc number parsed from a disc-rollup folder
 */

/**
 * Cleans a filename into a display title plus an optional leading track
 * number, per the "Filename cleaning" spec rule (shared by both parsers).
 * @param {string} fileName exact on-disk filename, with extension
 * @returns {{ title: string, trackNo: number|null }}
 */
function cleanFileName(fileName) {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const match = NUMBERED_STEM_RE.exec(stem);
  let title = stem;
  let trackNo = null;
  if (match) {
    trackNo = Number(match[1]);
    title = match[2];
  }
  if (!stem.includes(' ')) {
    title = title.replace(/_/g, ' ');
  }
  if (title.trim() === '') {
    title = stem;
  }
  return { title: title.normalize('NFC'), trackNo };
}

/**
 * Cleans a single-file book's filename into its book title, without the
 * leading-number stripping step (a book title may itself start with a
 * number).
 * @param {string} fileName exact on-disk filename, with extension
 * @returns {string}
 */
function cleanBookStem(fileName) {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  let title = stem;
  if (!stem.includes(' ')) {
    title = title.replace(/_/g, ' ');
  }
  if (title.trim() === '') {
    title = stem;
  }
  return title.normalize('NFC');
}

/**
 * Detects a disc-rollup folder ("CD 1", "Disc2", "Disk 03", case-insensitive).
 * @param {string} name a single path segment
 * @returns {number|null} the disc number, or null when `name` is not a disc folder
 */
function discFolderNumber(name) {
  const match = DISC_FOLDER_RE.exec(name);
  return match ? Number(match[2]) : null;
}

/**
 * Parses an audiobook item's relative path into its group (book) and file
 * fields. Pure, no I/O.
 * @param {string} relPath '/'-separated, relative to MEDIA_ROOT, exact on-disk form
 * @returns {ParsedAudiobookPath}
 */
export function parseAudiobookPath(relPath) {
  const segments = relPath.split('/');
  const categorySegment = segments[0];
  const fileName = segments[segments.length - 1];
  let dirs = segments.slice(1, -1);

  let folderDiscNo = null;
  if (dirs.length > 0) {
    const discNo = discFolderNumber(dirs[dirs.length - 1]);
    if (discNo !== null) {
      folderDiscNo = discNo;
      dirs = dirs.slice(0, -1);
    }
  }

  const { title: fileTitle, trackNo: fileTrackNo } = cleanFileName(fileName);

  if (dirs.length >= 2) {
    return {
      groupKey: [categorySegment, ...dirs].join('/'),
      groupTitle: dirs[dirs.length - 1].normalize('NFC'),
      groupArtist: dirs[0].normalize('NFC'),
      fileTitle,
      fileTrackNo,
      folderDiscNo,
    };
  }

  return {
    groupKey: relPath,
    groupTitle: cleanBookStem(fileName),
    groupArtist: dirs.length === 1 ? dirs[0].normalize('NFC') : null,
    fileTitle,
    fileTrackNo,
    folderDiscNo,
  };
}
