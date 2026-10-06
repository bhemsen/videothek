ALTER TABLE conversions ADD COLUMN sidecars TEXT NOT NULL DEFAULT '[]'; -- JSON array of { file, lang }; sub-<n>.vtt under the storage_key dir
ALTER TABLE conversions ADD COLUMN missing_since INTEGER;               -- epoch ms the source was first seen missing; NULL while present
