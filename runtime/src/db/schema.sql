PRAGMA application_id = 1380270916;
PRAGMA user_version = 3;

BEGIN;

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  root_name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK(
    mime_type GLOB 'image/?*' OR
    mime_type GLOB 'video/?*'
  ),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  mtime_ms REAL NOT NULL CHECK(mtime_ms >= 0),
  content TEXT NOT NULL DEFAULT '',
  duration_seconds REAL CHECK(duration_seconds >= 0 AND duration_seconds < 1.0e308),
  important INTEGER NOT NULL DEFAULT 0 CHECK(important IN (0, 1)),
  note_color TEXT CHECK(note_color IN ('white', 'butter', 'blush', 'mint', 'sky', 'lavender')),
  content_fingerprint TEXT,
  exif_data TEXT CHECK(exif_data IS NULL OR (json_valid(exif_data) AND json_type(exif_data) = 'object')),
  source_revision TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(root_name, relative_path)
);

CREATE INDEX idx_attachments_created ON attachments(created_at);
CREATE INDEX idx_attachments_mime_created ON attachments(mime_type, created_at);
CREATE INDEX idx_attachments_fingerprint
  ON attachments(content_fingerprint) WHERE content_fingerprint IS NOT NULL;

COMMIT;
