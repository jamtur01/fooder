import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS session (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase TEXT NOT NULL CHECK (phase IN ('cuisines', 'restaurants', 'done')),
  cuisine_stage TEXT NOT NULL DEFAULT 'swipe' CHECK (cuisine_stage IN ('swipe', 'bracket')),
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

CREATE TABLE IF NOT EXISTS bracket_round (
  session_id INTEGER NOT NULL REFERENCES session(id),
  round_index INTEGER NOT NULL,
  pair_index INTEGER NOT NULL,
  item_a TEXT NOT NULL,
  item_b TEXT,
  outcome TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'a_wins', 'b_wins', 'both')),
  PRIMARY KEY (session_id, round_index, pair_index)
);

CREATE TABLE IF NOT EXISTS bracket_vote (
  session_id INTEGER NOT NULL REFERENCES session(id),
  round_index INTEGER NOT NULL,
  pair_index INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('a', 'b')),
  pick TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, round_index, pair_index, side)
);

CREATE INDEX IF NOT EXISTS idx_swipe_session ON swipe(session_id, phase);
CREATE INDEX IF NOT EXISTS idx_bracket_round_session ON bracket_round(session_id, round_index);
`;

export function migrateSchema(db) {
  const cols = db.prepare("PRAGMA table_info('session')").all().map(c => c.name);
  if (cols.length > 0 && !cols.includes('cuisine_stage')) {
    db.exec(
      "ALTER TABLE session ADD COLUMN cuisine_stage TEXT NOT NULL DEFAULT 'swipe' " +
      "CHECK (cuisine_stage IN ('swipe', 'bracket'))"
    );
  }
}

export function openDb(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrateSchema(db);
  db.exec(SCHEMA);
  return db;
}
