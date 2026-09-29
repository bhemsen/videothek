CREATE TABLE conversions (
  rel_path        TEXT    PRIMARY KEY,         -- = library_items.rel_path, never an FK
  storage_key     TEXT    NOT NULL UNIQUE,     -- sha256(rel_path UTF-8) lower-case hex, 64 chars
  target          TEXT    NOT NULL CHECK (target IN ('web', 'flac', 'opus')),
  status          TEXT    NOT NULL CHECK (status IN ('queued', 'converting', 'playable', 'failed')),
  source_size     INTEGER NOT NULL,            -- source stat the copy belongs to
  source_mtime_ms INTEGER NOT NULL,            -- Math.trunc(stat.mtimeMs), same rule as library_items.mtime_ms
  output_rel      TEXT,                        -- '<storage_key>/<file>' relative to CONVERT_DIR; set iff a verified copy exists
  output_size     INTEGER,                     -- bytes of output_rel
  notes           TEXT    NOT NULL DEFAULT '[]', -- JSON array of converter notes (≤ 10 × 200 chars)
  error           TEXT,                        -- failure code (table below), NULL unless status = 'failed'
  error_detail    TEXT,                        -- ≤ 500 chars, redacted, NULL unless failed
  queued_at       INTEGER NOT NULL,            -- epoch ms, deps.now()
  started_at      INTEGER,
  finished_at     INTEGER
) STRICT;
CREATE INDEX conversions_queue ON conversions (status, queued_at, rel_path);
