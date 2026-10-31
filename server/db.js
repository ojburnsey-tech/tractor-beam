// SQLite storage via Node's built-in driver. One file, WAL mode, foreign keys
// on so deleting an account removes everything that belongs to it.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  auth_hash TEXT NOT NULL,
  kdf_iterations INTEGER NOT NULL,
  vault TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  browser TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_user ON devices(user_id);

CREATE TABLE IF NOT EXISTS link_requests (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  public_key TEXT NOT NULL,
  name TEXT NOT NULL,
  browser TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT,
  token TEXT,
  wrapped_key TEXT,
  claim_attempts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS downloads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  device_id TEXT,
  seq INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  state TEXT NOT NULL,
  kind TEXT,
  method TEXT,
  mode TEXT,
  live INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER,
  received INTEGER,
  media_duration REAL,
  elapsed_ms INTEGER,
  active_ms INTEGER,
  avg_speed REAL,
  peak_speed REAL,
  height INTEGER,
  codecs TEXT,
  container TEXT,
  fps REAL,
  concurrency INTEGER,
  concurrency_auto INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  samples TEXT,
  sealed TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS downloads_seq ON downloads(user_id, seq);

CREATE TABLE IF NOT EXISTS tombstones (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS tombstones_seq ON tombstones(user_id, seq);

CREATE TABLE IF NOT EXISTS inbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_device_id TEXT,
  sealed TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  opened_at INTEGER,
  opened_by TEXT
);
CREATE INDEX IF NOT EXISTS inbox_user ON inbox(user_id, created_at);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
`;

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, "library.sqlite"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('schema', '1')").run();
  return db;
}

/** Runs `work` in a transaction; rolls back if it throws. */
export function transaction(db, work) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Next change number for a user; used as the sync cursor. */
export function nextSeq(db, userId) {
  return db.prepare("UPDATE users SET seq = seq + 1 WHERE id = ? RETURNING seq").get(userId).seq;
}

export function getMeta(db, key) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
