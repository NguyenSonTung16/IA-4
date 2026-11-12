-- v2: links can expire, behind a flag stored in the database.
-- Additive on purpose: v1 keeps running on this schema (it never names expires_at or flags).
ALTER TABLE links ADD COLUMN expires_at TEXT;
CREATE TABLE flags (
  name    TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0
);
INSERT INTO flags (name, enabled) VALUES ('expiry', 0);
