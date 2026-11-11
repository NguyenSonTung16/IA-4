CREATE TABLE links (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE,
  url        TEXT NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
