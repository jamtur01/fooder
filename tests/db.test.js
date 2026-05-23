import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';

describe('openDb', () => {
  it('creates schema and is queryable', () => {
    const db = openDb(':memory:');
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map(r => r.name);
    expect(tables).toEqual(['place_cache', 'restaurant_cache', 'session', 'swipe']);
  });

  it('enforces phase check constraint on session', () => {
    const db = openDb(':memory:');
    expect(() =>
      db.prepare('INSERT INTO session(phase, created_at, updated_at) VALUES (?,?,?)')
        .run('bogus', 1, 1)
    ).toThrow();
  });

  it('makes swipes idempotent via primary key', () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO session(phase, created_at, updated_at) VALUES (?,?,?)')
      .run('cuisines', 1, 1);
    const insertSwipe = db.prepare(
      'INSERT OR REPLACE INTO swipe(session_id, side, phase, item_id, direction, created_at) VALUES (?,?,?,?,?,?)'
    );
    insertSwipe.run(1, 'a', 'cuisines', 'thai', 'right', 1);
    insertSwipe.run(1, 'a', 'cuisines', 'thai', 'left', 2);  // overwrite
    const rows = db.prepare('SELECT direction FROM swipe').all();
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('left');
  });
});
