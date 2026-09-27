CREATE TABLE image_meta (
  item_id         INTEGER PRIMARY KEY REFERENCES library_items(id) ON DELETE CASCADE,
  folder          TEXT    NOT NULL,  -- gallery folder key (image-folders.js), '' = category root
  taken_at        TEXT,              -- 'YYYY-MM-DDTHH:MM:SS', NULL = no usable EXIF date yet
  orientation     INTEGER,           -- EXIF orientation 1-8, NULL = not read yet or no EXIF
  thumb_offset    INTEGER,           -- absolute byte offset of the embedded JPEG thumbnail
  thumb_length    INTEGER,           -- byte length of the embedded JPEG thumbnail
  source_size     INTEGER,           -- library_items.size at the time the header was last read
  source_mtime_ms INTEGER,           -- library_items.mtime_ms at the time the header was last read
  meta_version    INTEGER            -- IMAGE_META_VERSION at the time the header was last read
) STRICT;

CREATE INDEX image_meta_folder ON image_meta (folder);
