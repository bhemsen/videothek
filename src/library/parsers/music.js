/**
 * Pure folder-convention parser for music items: no I/O, no imports from
 * `src/db` or `src/http`. The category folder segment (any of its aliases,
 * e.g. "Musik" / "Music") is used only structurally — its name is never
 * matched — so alias resolution stays Phase 2's concern.
 *
 * Spec: docs/specs/spec-music-audiobooks.md — "Music folder convention" and
 * "Filename cleaning" decision-log rows.
 */

const DISC_FOLDER_RE = /^(cd|disc|disk)\s*(\d+)$/i;
const NUMBERED_STEM_RE = /^(\d{1,3})[\s._-]+(.+)$/;

/**
 * @typedef {object} ParsedMusicPath
 * @property {string} groupKey rel path of the album directory (exact on-disk form); the category folder itself when there is no album directory
 * @property {string|null} groupTitle album title from the folder name; null for a pseudo-album
 * @property {string|null} groupArtist artist folder name; null only for the root pseudo-album
 * @property {string} fileTitle cleaned, NFC-normalised track title
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
 * Detects a disc-rollup folder ("CD 1", "Disc2", "Disk 03", case-insensitive).
 * @param {string} name a single path segment
 * @returns {number|null} the disc number, or null when `name` is not a disc folder
 */
function discFolderNumber(name) {
  const match = DISC_FOLDER_RE.exec(name);
  return match ? Number(match[2]) : null;
}

/**
 * Parses a music item's relative path into its group (album) and file
 * fields. Pure, no I/O.
 * @param {string} relPath '/'-separated, relative to MEDIA_ROOT, exact on-disk form
 * @returns {ParsedMusicPath}
 */
export function parseMusicPath(relPath) {
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

  let groupTitle = null;
  let groupArtist = null;
  if (dirs.length >= 2) {
    groupTitle = dirs[dirs.length - 1].normalize('NFC');
    groupArtist = dirs[0].normalize('NFC');
  } else if (dirs.length === 1) {
    groupArtist = dirs[0].normalize('NFC');
  }

  const groupKey = [categorySegment, ...dirs].join('/');
  const { title: fileTitle, trackNo: fileTrackNo } = cleanFileName(fileName);

  return { groupKey, groupTitle, groupArtist, fileTitle, fileTrackNo, folderDiscNo };
}
