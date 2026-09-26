CREATE TABLE progress (
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rel_path         TEXT    NOT NULL,          -- = library_items.rel_path, never an FK
  position_seconds REAL    NOT NULL CHECK (position_seconds >= 0),
  duration_seconds REAL    NOT NULL CHECK (duration_seconds > 0),
  finished         INTEGER NOT NULL DEFAULT 0 CHECK (finished IN (0, 1)),
  updated_at       INTEGER NOT NULL,          -- epoch ms, server clock
  PRIMARY KEY (user_id, rel_path)
) STRICT;
CREATE INDEX progress_user_updated ON progress (user_id, updated_at DESC);
