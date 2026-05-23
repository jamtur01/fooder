import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase TEXT NOT NULL CHECK (phase IN ('cuisines', 'restaurants', 'done')),
  matched_cuisine TEXT,
  matched_restaurant_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS swipe (
  session_id INTEGER NOT NULL REFERENCES session(id),
  side TEXT NOT NULL CHECK (side IN ('a', 'b')),
  phase TEXT NOT NULL,
  item_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('left', 'right')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, side, phase, item_id)
);

CREATE TABLE IF NOT EXISTS restaurant_cache (
  cuisine TEXT NOT NULL,
  location TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (cuisine, location)
);

CREATE TABLE IF NOT EXISTS place_cache (
  place_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_swipe_session ON swipe(session_id, phase);
`;

export function openDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
