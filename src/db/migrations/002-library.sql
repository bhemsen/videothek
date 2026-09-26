CREATE TABLE library_series (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  series_key TEXT    NOT NULL UNIQUE,  -- series folder name (exact) or cleaned name of a loose file
  title      TEXT    NOT NULL,
  sort_title TEXT    NOT NULL,
  year       INTEGER,
  added_at   INTEGER NOT NULL          -- epoch ms, first time seen
) STRICT;

CREATE TABLE library_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  rel_path     TEXT    NOT NULL UNIQUE,   -- '/'-separated, relative to MEDIA_ROOT, exact on-disk name
  dir          TEXT    NOT NULL,          -- parent directory of rel_path (same form)
  category     TEXT    NOT NULL CHECK (category IN ('movies','series','music','audiobooks','images')),
  kind         TEXT    NOT NULL CHECK (kind IN ('video','audio','image')),
  ext          TEXT    NOT NULL,          -- lower-case, without dot
  title        TEXT    NOT NULL,          -- best-effort display title, never empty
  sort_title   TEXT    NOT NULL,
  year         INTEGER,
  series_id    INTEGER REFERENCES library_series(id),  -- NOT NULL for category 'series', NULL otherwise
  series_title TEXT,                      -- denormalised for serializers without a join
  season       INTEGER,                   -- 0 = specials, NULL = unknown
  episode      INTEGER,
  episode_end  INTEGER,                   -- multi-episode files (S01E01-E02)
  video_codec  TEXT,                      -- first 'vide' sample-entry fourcc from the sniffer, else NULL
  audio_codec  TEXT,                      -- first 'soun' sample-entry fourcc, else NULL
  playable     INTEGER NOT NULL CHECK (playable IN (0, 1)),
  size         INTEGER NOT NULL,
  mtime_ms     INTEGER NOT NULL,          -- Math.trunc(stat.mtimeMs)
  scan_version INTEGER NOT NULL,          -- SCAN_VERSION at parse time
  added_at     INTEGER NOT NULL,          -- epoch ms, set on insert only
  scanned_at   INTEGER NOT NULL           -- epoch ms, last (re)parse
) STRICT;

CREATE INDEX library_items_category_sort ON library_items (category, sort_title);
CREATE INDEX library_items_dir ON library_items (dir);
CREATE INDEX library_items_series ON library_items (series_id, season, episode);
