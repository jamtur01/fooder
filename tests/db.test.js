import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';

describe('openDb', () => {
  it('creates all five tables and the cuisine_stage column on session', () => {
    const db = openDb(':memory:');
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(r => r.name);
    expect(tables).toEqual(['bracket_round', 'bracket_vote', 'place_cache', 'restaurant_cache', 'session', 'swipe']);
    const cols = db.prepare("PRAGMA table_info('session')").all().map(c => c.name);
    expect(cols).toContain('cuisine_stage');
    expect(cols).toContain('deck_json');
  });

  it('enforces phase check constraint on session', () => {
    const db = openDb(':memory:');
    expect(() =>
      db.prepare('INSERT INTO session(phase, cuisine_stage, created_at, updated_at) VALUES (?,?,?,?)')
        .run('bogus', 'swipe', 1, 1)
    ).toThrow();
  });

  it('enforces cuisine_stage check constraint', () => {
    const db = openDb(':memory:');
    expect(() =>
      db.prepare('INSERT INTO session(phase, cuisine_stage, created_at, updated_at) VALUES (?,?,?,?)')
        .run('cuisines', 'bogus', 1, 1)
    ).toThrow();
  });

  it('makes swipes idempotent via primary key', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO session(phase, cuisine_stage, created_at, updated_at) VALUES (?,?,?,?)')
      .run('cuisines', 'swipe', 1, 1);
    const insertSwipe = db.prepare(
      'INSERT OR REPLACE INTO swipe(session_id, side, phase, item_id, direction, created_at) VALUES (?,?,?,?,?,?)'
    );
    insertSwipe.run(1, 'a', 'cuisines', 'thai', 'right', 1);
    insertSwipe.run(1, 'a', 'cuisines', 'thai', 'left', 2);
    const rows = db.prepare('SELECT direction FROM swipe').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('left');
  });

  it('bracket vote primary key (session_id, round, pair, side) prevents dup votes', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO session(phase, cuisine_stage, created_at, updated_at) VALUES (?,?,?,?)')
      .run('cuisines', 'bracket', 1, 1);
    db.prepare(
      'INSERT INTO bracket_round(session_id, round_index, pair_index, item_a, item_b) VALUES (?,?,?,?,?)'
    ).run(1, 0, 0, 'thai', 'sushi');
    const insertVote = db.prepare(
      'INSERT OR REPLACE INTO bracket_vote(session_id, round_index, pair_index, side, pick, created_at) VALUES (?,?,?,?,?,?)'
    );
    insertVote.run(1, 0, 0, 'a', 'thai', 1);
    insertVote.run(1, 0, 0, 'a', 'sushi', 2);
    expect(db.prepare('SELECT pick FROM bracket_vote').all()).toEqual([{ pick: 'sushi' }]);
  });

  it('migrates an existing v1 db (session table without cuisine_stage)', async () => {
    const v1 = new Database(':memory:');
    v1.exec(`
      CREATE TABLE session (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phase TEXT NOT NULL,
        matched_cuisine TEXT,
        matched_restaurant_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    v1.prepare('INSERT INTO session(phase, created_at, updated_at) VALUES (?,?,?)').run('cuisines', 1, 1);
    const { migrateSchema } = await import('../src/db.js');
    migrateSchema(v1);
    const cols = v1.prepare("PRAGMA table_info('session')").all().map(c => c.name);
    expect(cols).toContain('cuisine_stage');
    const row = v1.prepare('SELECT cuisine_stage FROM session WHERE id = 1').get();
    expect(row.cuisine_stage).toBe('swipe');
  });
});

describe('migrateSchema — deck_json', () => {
  it('adds deck_json to an existing session table missing it', async () => {
    const v2 = new Database(':memory:');
    v2.exec(`
      CREATE TABLE session (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        phase TEXT NOT NULL,
        cuisine_stage TEXT NOT NULL DEFAULT 'swipe',
        matched_cuisine TEXT,
        matched_restaurant_json TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    v2.prepare('INSERT INTO session(phase, created_at, updated_at) VALUES (?,?,?)').run('cuisines', 1, 1);
    const { migrateSchema } = await import('../src/db.js');
    migrateSchema(v2);
    const cols = v2.prepare("PRAGMA table_info('session')").all().map(c => c.name);
    expect(cols).toContain('deck_json');
    expect(v2.prepare('SELECT deck_json FROM session WHERE id=1').get().deck_json).toBeNull();
  });
});
