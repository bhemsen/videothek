CREATE TABLE audio_meta (
  item_id          INTEGER PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
  meta_version     INTEGER NOT NULL,  -- AUDIO_META_VERSION when written
  source_mtime_ms  INTEGER NOT NULL,  -- library_items.mtime_ms when read
  source_size      INTEGER NOT NULL,  -- library_items.size when read
  group_key        TEXT    NOT NULL,  -- rel path of the album/book dir, or of the file (single-file book)
  group_title      TEXT,              -- folder-derived album/book title; NULL = pseudo-album
  group_artist     TEXT,              -- folder-derived artist/author; NULL = unknown
  title            TEXT    NOT NULL,  -- resolved track/file title (tag, else cleaned filename)
  track_no         INTEGER,           -- resolved (tag, else filename number)
  disc_no          INTEGER NOT NULL,  -- resolved (tag, else disc folder, else 1)
  tag_artist       TEXT,
  tag_album_artist TEXT,
  tag_album        TEXT,
  tag_year         INTEGER,
  duration_ms      INTEGER,           -- NULL = unknown
  tag_format       TEXT CHECK (tag_format IN ('id3v2', 'flac'))  -- NULL = no tag read
) STRICT;
CREATE INDEX audio_meta_group ON audio_meta (group_key);
