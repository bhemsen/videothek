ALTER TABLE conversions ADD COLUMN sidecars TEXT NOT NULL DEFAULT '[]'; -- JSON array of sidecar file names next to output_rel
ALTER TABLE conversions ADD COLUMN missing_since INTEGER;               -- epoch ms the source was first seen missing; NULL while present
