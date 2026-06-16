CREATE TABLE IF NOT EXISTS clipboard_items (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
