CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,          -- normalized (see rules)
  password_hash TEXT    NOT NULL,                 -- scrypt$N$r$p$saltB64$hashB64
  role          TEXT    NOT NULL CHECK (role IN ('admin', 'user')),
  created_at    INTEGER NOT NULL                  -- epoch ms
) STRICT;
CREATE TABLE sessions (
  id         TEXT    PRIMARY KEY,                 -- sha256 hex of the token
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX sessions_user_id ON sessions(user_id);
CREATE INDEX sessions_expires_at ON sessions(expires_at);
