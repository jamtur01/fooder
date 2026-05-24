# Cuisine Bracket Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace instant cuisine matching with a two-stage cuisines phase — both partners blind-swipe the whole deck, then run a tap-based elimination bracket over the overlap.

**Architecture:** Add a new internal stage (`cuisine_stage` column on `session`) so the cuisines phase has `swipe` and `bracket` sub-states. Bracket logic lives in a new `src/bracket.js` module. Session module gives up its instant-cuisine-match behavior. Routes gain a `/api/bracket-vote` endpoint and stage-aware behavior on existing endpoints. Frontend adds three views (waiting, bracket, no-overlap) and a few new SSE handlers.

**Tech Stack:** Node 24, Express 5, better-sqlite3 12, vitest 4, vanilla HTML/CSS/JS frontend.

**Spec:** `docs/superpowers/specs/2026-05-23-cuisine-bracket-design.md`

---

## File structure

| File | Responsibility | Change type |
|------|----------------|-------------|
| `src/db.js` | Schema + migration helper to add `cuisine_stage` to existing dbs | Modify |
| `src/session.js` | Drop cuisine instant match; add `bothDoneSwipingCuisines`, `computeCuisineOverlap`, `setCuisineStage` | Modify |
| `src/bracket.js` | Pure bracket logic + db ops: pair items, create round, record vote, resolve pair, build next round, loop-break | Create |
| `src/routes.js` | Extend `/api/state`; stage-aware `/api/swipe`; new `/api/bracket-vote`; stage-aware `/api/reset` | Modify |
| `public/index.html` | Add `view-cuisines-waiting`, `view-bracket`, `view-no-overlap` sections | Modify |
| `public/app.js` | Read new state fields, render new views, handle new SSE events, post bracket votes | Modify |
| `public/app.css` | Bracket side-by-side / stacked card layout, waiting overlay | Modify |
| `tests/db.test.js` | Bracket tables present; migration adds column to old session-only schema | Modify |
| `tests/session.test.js` | Cuisine swipe no longer reports match; new helpers covered | Modify |
| `tests/bracket.test.js` | Pure pairing + DB-backed round/vote/resolve flow including loop-break | Create |
| `tests/routes.test.js` | Stage-aware swipe, bracket-vote endpoint, state shape extensions | Modify |
| `tests/integration.test.js` | Full flow: swipe-all → 3-way bracket with a tie → restaurants | Modify |
| `tests/helpers.js` | Default stub `placesOverride` unchanged; no bracket stubs needed | (Modify if missing methods) |
| `README.md` | Update flow description for the new cuisines stages | Modify |

---

## Shared type shapes used across tasks

```js
// New session row fields (cuisine_stage TEXT NOT NULL DEFAULT 'swipe' CHECK in ('swipe','bracket'))
{
  id, phase, matched_cuisine, matched_restaurant_json, created_at, updated_at,
  cuisine_stage: 'swipe' | 'bracket',
}

// bracket_round row
{ session_id, round_index, pair_index, item_a, item_b,
  outcome: 'pending' | 'a_wins' | 'b_wins' | 'both' }

// bracket_vote row
{ session_id, round_index, pair_index, side: 'a'|'b', pick: <itemId>, created_at }

// Vote result returned by recordBracketVote
{ resolved: false } | { resolved: true, outcome: 'a_wins'|'b_wins'|'both', winners: [itemId, ...] }

// Round-build result
{ done: false, round: [{ pairIndex, itemA, itemB }] } |
{ done: true, winner: <itemId> }

// New SSE event types (spec § "SSE event additions")
'partner-done'           // { side, swipedCount }
'stage-change'           // { stage: 'bracket' | 'no-overlap', bracket?: { ... } }
'bracket-pair-resolved'  // { pairIndex, outcome, winner | null }
'bracket-round-start'    // { roundIndex, currentPair }
'bracket-vote-cast'      // { side, pairIndex }   (no `pick`, kept private)
```

---

## Task 1: DB schema additions + migration

**Files:**
- Modify: `src/db.js`
- Modify: `tests/db.test.js`

The cuisine instant-match drop and bracket flow both depend on a new `cuisine_stage` column on `session` and two new tables. New databases get the column via the `CREATE TABLE IF NOT EXISTS`. Existing databases need a one-shot `ALTER TABLE` because `IF NOT EXISTS` is a no-op when the table already exists.

- [ ] **Step 1: Write failing tests**

Replace the existing `creates schema and is queryable` test and add a migration case:

```js
// tests/db.test.js
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

  it('migrates an existing v1 db (only session/swipe/cache tables, no cuisine_stage)', () => {
    // Build a v1-shaped database, then reopen via openDb()
    const path = ':memory:';
    const v1 = new Database(path);
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
    // Hand the same in-process handle through openDb's migration logic
    // openDb expects a path, but the migration helper is exported separately for this test.
    const { migrateSchema } = await import('../src/db.js');
    migrateSchema(v1);
    const cols = v1.prepare("PRAGMA table_info('session')").all().map(c => c.name);
    expect(cols).toContain('cuisine_stage');
    const stage = v1.prepare('SELECT cuisine_stage FROM session WHERE id = 1').get();
    expect(stage.cuisine_stage).toBe('swipe');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test -- db`
Expected: failures on new tables (`bracket_round` missing) and the migration test (`migrateSchema` not exported).

- [ ] **Step 3: Implement the schema and migration**

Replace `src/db.js` entirely:

```js
// src/db.js
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
  item_b TEXT NOT NULL,
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
  // Add session.cuisine_stage to pre-existing v1 databases.
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
```

- [ ] **Step 4: Run tests**

Run: `npm test -- db`
Expected: all six tests pass.

- [ ] **Step 5: Commit**

```bash
jj commit -m "db: cuisine_stage column, bracket tables, v1 migration helper"
```

---

## Task 2: Session — drop cuisine instant match + add stage helpers

**Files:**
- Modify: `src/session.js`
- Modify: `tests/session.test.js`

The session module currently emits `{ matched: true }` from `recordSwipe` when both sides right-swipe the same item — in either phase. After this task, cuisine matches do not trigger that; restaurants still do. The module gains four small helpers used by routes.

- [ ] **Step 1: Update session tests**

Replace the `describe('recordSwipe + match detection (cuisines)', ...)` block in `tests/session.test.js` and append new tests:

```js
describe('recordSwipe — cuisines phase no longer reports instant match', () => {
  it('returns matched:false even when both sides right-swipe the same cuisine', () => {
    const s = createSession(db);
    recordSwipe(db, { sessionId: s.id, side: 'a', phase: 'cuisines', itemId: 'thai', direction: 'right' });
    const result = recordSwipe(db, { sessionId: s.id, side: 'b', phase: 'cuisines', itemId: 'thai', direction: 'right' });
    expect(result.matched).toBe(false);
  });
});

describe('recordSwipe — restaurants phase still reports instant match', () => {
  it('returns matched:true when both right-swipe the same restaurant', () => {
    const s = createSession(db);
    recordSwipe(db, { sessionId: s.id, side: 'a', phase: 'restaurants', itemId: 'ChIJ1', direction: 'right' });
    const result = recordSwipe(db, { sessionId: s.id, side: 'b', phase: 'restaurants', itemId: 'ChIJ1', direction: 'right' });
    expect(result.matched).toBe(true);
    expect(result.itemId).toBe('ChIJ1');
  });
});

import { bothDoneSwipingCuisines, computeCuisineOverlap, setCuisineStage, getSessionById } from '../src/session.js';

describe('bothDoneSwipingCuisines', () => {
  const deckIds = ['pizza', 'thai', 'sushi'];
  it('false until each side has swiped every deck item', () => {
    const s = createSession(db);
    for (const id of deckIds) recordSwipe(db, { sessionId: s.id, side: 'a', phase: 'cuisines', itemId: id, direction: 'left' });
    expect(bothDoneSwipingCuisines(db, s.id, deckIds)).toBe(false);
    for (const id of deckIds.slice(0, 2)) recordSwipe(db, { sessionId: s.id, side: 'b', phase: 'cuisines', itemId: id, direction: 'left' });
    expect(bothDoneSwipingCuisines(db, s.id, deckIds)).toBe(false);
    recordSwipe(db, { sessionId: s.id, side: 'b', phase: 'cuisines', itemId: 'sushi', direction: 'right' });
    expect(bothDoneSwipingCuisines(db, s.id, deckIds)).toBe(true);
  });
});

describe('computeCuisineOverlap', () => {
  const deckIds = ['pizza', 'thai', 'sushi', 'burgers'];
  it('returns deck-ordered intersection of right-swipes from both sides', () => {
    const s = createSession(db);
    // A: right=thai, sushi. B: right=sushi, burgers. Overlap = [sushi].
    recordSwipe(db, { sessionId: s.id, side: 'a', phase: 'cuisines', itemId: 'thai', direction: 'right' });
    recordSwipe(db, { sessionId: s.id, side: 'a', phase: 'cuisines', itemId: 'sushi', direction: 'right' });
    recordSwipe(db, { sessionId: s.id, side: 'b', phase: 'cuisines', itemId: 'sushi', direction: 'right' });
    recordSwipe(db, { sessionId: s.id, side: 'b', phase: 'cuisines', itemId: 'burgers', direction: 'right' });
    expect(computeCuisineOverlap(db, s.id, deckIds)).toEqual(['sushi']);
  });

  it('preserves deck order for multiple overlap items', () => {
    const s = createSession(db);
    for (const id of ['burgers', 'pizza', 'thai']) {
      recordSwipe(db, { sessionId: s.id, side: 'a', phase: 'cuisines', itemId: id, direction: 'right' });
      recordSwipe(db, { sessionId: s.id, side: 'b', phase: 'cuisines', itemId: id, direction: 'right' });
    }
    // deck order is pizza, thai, sushi, burgers → overlap in deck order:
    expect(computeCuisineOverlap(db, s.id, deckIds)).toEqual(['pizza', 'thai', 'burgers']);
  });
});

describe('setCuisineStage', () => {
  it('updates cuisine_stage and returns the new session', () => {
    const s = createSession(db);
    expect(s.cuisineStage).toBe('swipe');
    const updated = setCuisineStage(db, s.id, 'bracket');
    expect(updated.cuisineStage).toBe('bracket');
    expect(getSessionById(db, s.id).cuisineStage).toBe('bracket');
  });
  it('rejects invalid stage values', () => {
    const s = createSession(db);
    expect(() => setCuisineStage(db, s.id, 'bogus')).toThrow();
  });
});
```

Also extend `tests/session.test.js`'s existing `getCurrentSession` and `createSession` tests to assert `cuisineStage === 'swipe'`.

- [ ] **Step 2: Run tests to verify failures**

Run: `npm test -- session`
Expected: cuisine instant match test now fails (was passing); helpers missing.

- [ ] **Step 3: Update session.js**

Modify the `recordSwipe` body to gate the match detection on phase:

```js
// src/session.js  (replace recordSwipe entirely)
export function recordSwipe(db, { sessionId, side, phase, itemId, direction }) {
  db.prepare(
    'INSERT OR REPLACE INTO swipe(session_id, side, phase, item_id, direction, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(sessionId, side, phase, itemId, direction, now());

  // Instant match is only meaningful for the restaurants phase; cuisines use the bracket flow.
  if (phase !== 'restaurants') return { matched: false };
  if (direction !== 'right') return { matched: false };
  const otherSide = side === 'a' ? 'b' : 'a';
  const other = db.prepare(
    'SELECT direction FROM swipe WHERE session_id=? AND side=? AND phase=? AND item_id=?'
  ).get(sessionId, otherSide, phase, itemId);
  if (other && other.direction === 'right') {
    return { matched: true, itemId };
  }
  return { matched: false };
}
```

Update `rowToSession` to expose `cuisineStage`:

```js
function rowToSession(r) {
  return {
    id: r.id,
    phase: r.phase,
    cuisineStage: r.cuisine_stage,
    matchedCuisine: r.matched_cuisine,
    matchedRestaurantJson: r.matched_restaurant_json,
  };
}
```

Add the new helpers (place near the bottom of the file):

```js
export function bothDoneSwipingCuisines(db, sessionId, deckIds) {
  const rows = db.prepare(
    "SELECT side, item_id FROM swipe WHERE session_id=? AND phase='cuisines'"
  ).all(sessionId);
  const aSwiped = new Set(rows.filter(r => r.side === 'a').map(r => r.item_id));
  const bSwiped = new Set(rows.filter(r => r.side === 'b').map(r => r.item_id));
  return deckIds.every(id => aSwiped.has(id) && bSwiped.has(id));
}

export function computeCuisineOverlap(db, sessionId, deckIds) {
  const rights = db.prepare(
    "SELECT side, item_id FROM swipe WHERE session_id=? AND phase='cuisines' AND direction='right'"
  ).all(sessionId);
  const aRight = new Set(rights.filter(r => r.side === 'a').map(r => r.item_id));
  const bRight = new Set(rights.filter(r => r.side === 'b').map(r => r.item_id));
  return deckIds.filter(id => aRight.has(id) && bRight.has(id));
}

export function setCuisineStage(db, sessionId, stage) {
  if (stage !== 'swipe' && stage !== 'bracket') {
    throw new Error(`setCuisineStage: invalid stage ${stage}`);
  }
  db.prepare('UPDATE session SET cuisine_stage=?, updated_at=? WHERE id=?')
    .run(stage, now(), sessionId);
  return getSessionById(db, sessionId);
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- session`
Expected: all session tests pass.

- [ ] **Step 5: Commit**

```bash
jj commit -m "session: drop cuisine instant match; add cuisine-stage helpers"
```

---

## Task 3: Bracket — pure pairing logic

**Files:**
- Create: `src/bracket.js`
- Create: `tests/bracket.test.js`

This task implements only the pure pairing function — no DB. Subsequent tasks add persistence.

- [ ] **Step 1: Write failing tests**

```js
// tests/bracket.test.js
import { describe, it, expect } from 'vitest';
import { pairItemsForRound } from '../src/bracket.js';

describe('pairItemsForRound', () => {
  it('returns [] for empty input', () => {
    expect(pairItemsForRound([])).toEqual([]);
  });
  it('returns one pair for two items', () => {
    expect(pairItemsForRound(['thai', 'sushi']))
      .toEqual([{ pairIndex: 0, itemA: 'thai', itemB: 'sushi' }]);
  });
  it('pairs sequentially in deck order for even counts', () => {
    expect(pairItemsForRound(['a','b','c','d']))
      .toEqual([
        { pairIndex: 0, itemA: 'a', itemB: 'b' },
        { pairIndex: 1, itemA: 'c', itemB: 'd' },
      ]);
  });
  it('gives the last item a bye for odd counts (itemB === null)', () => {
    expect(pairItemsForRound(['a','b','c']))
      .toEqual([
        { pairIndex: 0, itemA: 'a', itemB: 'b' },
        { pairIndex: 1, itemA: 'c', itemB: null },
      ]);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- bracket`
Expected: module not found.

- [ ] **Step 3: Implement**

```js
// src/bracket.js
export function pairItemsForRound(items) {
  const pairs = [];
  for (let i = 0; i < items.length; i += 2) {
    pairs.push({
      pairIndex: pairs.length,
      itemA: items[i],
      itemB: i + 1 < items.length ? items[i + 1] : null,
    });
  }
  return pairs;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- bracket`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
jj commit -m "bracket: pure pairItemsForRound (deck order, bye on odd)"
```

---

## Task 4: Bracket — create round, record vote, resolve pair (DB-backed)

**Files:**
- Modify: `src/bracket.js`
- Modify: `tests/bracket.test.js`

- [ ] **Step 1: Write failing tests**

Append to `tests/bracket.test.js`:

```js
import { beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import {
  createRound, recordBracketVote, getCurrentPair, getRoundPairs,
} from '../src/bracket.js';
import { createSession } from '../src/session.js';

let db, sid;
beforeEach(() => {
  db = openDb(':memory:');
  sid = createSession(db).id;
});

describe('createRound', () => {
  it('persists round 0 pairs from a deck-ordered overlap', () => {
    createRound(db, sid, 0, ['thai', 'sushi', 'pizza']);
    const rows = db.prepare(
      'SELECT round_index, pair_index, item_a, item_b, outcome FROM bracket_round WHERE session_id=? ORDER BY pair_index'
    ).all(sid);
    expect(rows).toEqual([
      { round_index: 0, pair_index: 0, item_a: 'thai', item_b: 'sushi', outcome: 'pending' },
      // The bye stores item_b=null and resolves immediately to a_wins
      { round_index: 0, pair_index: 1, item_a: 'pizza', item_b: null, outcome: 'a_wins' },
    ]);
  });
});

describe('getCurrentPair', () => {
  it('returns the lowest-pair-index pending pair in the highest existing round', () => {
    createRound(db, sid, 0, ['thai', 'sushi', 'pizza']);
    const cur = getCurrentPair(db, sid);
    expect(cur).toEqual({ roundIndex: 0, pairIndex: 0, itemA: 'thai', itemB: 'sushi' });
  });
  it('returns null when every pair is resolved', () => {
    createRound(db, sid, 0, ['thai']);  // single-item bracket: bye, immediate winner
    expect(getCurrentPair(db, sid)).toBeNull();
  });
});

describe('recordBracketVote — both sides vote, pair resolves', () => {
  it('resolved=false when only one side has voted', () => {
    createRound(db, sid, 0, ['thai', 'sushi']);
    const r = recordBracketVote(db, sid, { side: 'a', pairIndex: 0, pick: 'thai' });
    expect(r).toEqual({ resolved: false });
  });
  it('a_wins when both sides pick item_a', () => {
    createRound(db, sid, 0, ['thai', 'sushi']);
    recordBracketVote(db, sid, { side: 'a', pairIndex: 0, pick: 'thai' });
    const r = recordBracketVote(db, sid, { side: 'b', pairIndex: 0, pick: 'thai' });
    expect(r).toEqual({ resolved: true, outcome: 'a_wins', winners: ['thai'] });
  });
  it('b_wins when both sides pick item_b', () => {
    createRound(db, sid, 0, ['thai', 'sushi']);
    recordBracketVote(db, sid, { side: 'a', pairIndex: 0, pick: 'sushi' });
    const r = recordBracketVote(db, sid, { side: 'b', pairIndex: 0, pick: 'sushi' });
    expect(r).toEqual({ resolved: true, outcome: 'b_wins', winners: ['sushi'] });
  });
  it('both when sides disagree (both items advance)', () => {
    createRound(db, sid, 0, ['thai', 'sushi']);
    recordBracketVote(db, sid, { side: 'a', pairIndex: 0, pick: 'thai' });
    const r = recordBracketVote(db, sid, { side: 'b', pairIndex: 0, pick: 'sushi' });
    expect(r).toEqual({ resolved: true, outcome: 'both', winners: ['thai', 'sushi'] });
  });
  it('rejects pick that does not match item_a or item_b', () => {
    createRound(db, sid, 0, ['thai', 'sushi']);
    expect(() => recordBracketVote(db, sid, { side: 'a', pairIndex: 0, pick: 'pizza' }))
      .toThrow(/pick/);
  });
  it('rejects vote against a pair that does not exist', () => {
    createRound(db, sid, 0, ['thai', 'sushi']);
    expect(() => recordBracketVote(db, sid, { side: 'a', pairIndex: 99, pick: 'thai' }))
      .toThrow(/pair/);
  });
  it('rejects vote against an already-resolved pair', () => {
    createRound(db, sid, 0, ['thai', 'sushi']);
    recordBracketVote(db, sid, { side: 'a', pairIndex: 0, pick: 'thai' });
    recordBracketVote(db, sid, { side: 'b', pairIndex: 0, pick: 'thai' });
    expect(() => recordBracketVote(db, sid, { side: 'a', pairIndex: 0, pick: 'sushi' }))
      .toThrow(/resolved/);
  });
});

describe('getRoundPairs', () => {
  it('returns all pairs of the latest round with their outcomes', () => {
    createRound(db, sid, 0, ['thai', 'sushi', 'pizza', 'burgers']);
    recordBracketVote(db, sid, { side: 'a', pairIndex: 0, pick: 'thai' });
    recordBracketVote(db, sid, { side: 'b', pairIndex: 0, pick: 'thai' });
    expect(getRoundPairs(db, sid, 0)).toEqual([
      { pairIndex: 0, itemA: 'thai', itemB: 'sushi', outcome: 'a_wins' },
      { pairIndex: 1, itemA: 'pizza', itemB: 'burgers', outcome: 'pending' },
    ]);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- bracket`
Expected: module method failures.

- [ ] **Step 3: Implement**

Append to `src/bracket.js`:

```js
function now() { return Date.now(); }

export function createRound(db, sessionId, roundIndex, items) {
  const pairs = pairItemsForRound(items);
  const insert = db.prepare(
    'INSERT INTO bracket_round(session_id, round_index, pair_index, item_a, item_b, outcome) VALUES (?,?,?,?,?,?)'
  );
  const insertMany = db.transaction((rows) => {
    for (const p of rows) {
      // A bye (item_b === null) resolves to a_wins immediately so the round can advance naturally.
      const outcome = p.itemB === null ? 'a_wins' : 'pending';
      insert.run(sessionId, roundIndex, p.pairIndex, p.itemA, p.itemB, outcome);
    }
  });
  insertMany(pairs);
  return pairs;
}

export function getCurrentPair(db, sessionId) {
  const row = db.prepare(`
    SELECT round_index, pair_index, item_a, item_b
    FROM bracket_round
    WHERE session_id=? AND outcome='pending'
    ORDER BY round_index DESC, pair_index ASC
    LIMIT 1
  `).get(sessionId);
  if (!row) return null;
  return {
    roundIndex: row.round_index,
    pairIndex: row.pair_index,
    itemA: row.item_a,
    itemB: row.item_b,
  };
}

function latestRoundIndex(db, sessionId) {
  const row = db.prepare(
    'SELECT MAX(round_index) AS r FROM bracket_round WHERE session_id=?'
  ).get(sessionId);
  return row?.r ?? null;
}

export function getRoundPairs(db, sessionId, roundIndex) {
  return db.prepare(
    'SELECT pair_index AS pairIndex, item_a AS itemA, item_b AS itemB, outcome FROM bracket_round WHERE session_id=? AND round_index=? ORDER BY pair_index'
  ).all(sessionId, roundIndex);
}

export function recordBracketVote(db, sessionId, { side, pairIndex, pick }) {
  const round = latestRoundIndex(db, sessionId);
  if (round === null) throw new Error('no active bracket round');
  const pair = db.prepare(
    'SELECT item_a, item_b, outcome FROM bracket_round WHERE session_id=? AND round_index=? AND pair_index=?'
  ).get(sessionId, round, pairIndex);
  if (!pair) throw new Error(`bracket pair ${pairIndex} not found`);
  if (pair.outcome !== 'pending') throw new Error('pair already resolved');
  if (pick !== pair.item_a && pick !== pair.item_b) {
    throw new Error(`pick "${pick}" does not match pair items (${pair.item_a}, ${pair.item_b})`);
  }

  db.prepare(
    'INSERT OR REPLACE INTO bracket_vote(session_id, round_index, pair_index, side, pick, created_at) VALUES (?,?,?,?,?,?)'
  ).run(sessionId, round, pairIndex, side, pick, now());

  const votes = db.prepare(
    "SELECT side, pick FROM bracket_vote WHERE session_id=? AND round_index=? AND pair_index=?"
  ).all(sessionId, round, pairIndex);
  if (votes.length < 2) return { resolved: false };

  const a = votes.find(v => v.side === 'a').pick;
  const b = votes.find(v => v.side === 'b').pick;
  let outcome, winners;
  if (a === b && a === pair.item_a) { outcome = 'a_wins'; winners = [pair.item_a]; }
  else if (a === b && a === pair.item_b) { outcome = 'b_wins'; winners = [pair.item_b]; }
  else { outcome = 'both'; winners = [pair.item_a, pair.item_b]; }

  db.prepare(
    'UPDATE bracket_round SET outcome=? WHERE session_id=? AND round_index=? AND pair_index=?'
  ).run(outcome, sessionId, round, pairIndex);

  return { resolved: true, outcome, winners };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- bracket`
Expected: all bracket tests pass.

- [ ] **Step 5: Commit**

```bash
jj commit -m "bracket: createRound, recordBracketVote, resolution"
```

---

## Task 5: Bracket — build next round (with loop break)

**Files:**
- Modify: `src/bracket.js`
- Modify: `tests/bracket.test.js`

After every pair in a round resolves, build the next round from survivors. Survivors are taken in pair-index order: a resolved pair contributes its winner; a tied pair contributes both items (item_a then item_b). If only one survivor remains, the bracket is done. Loop break: if survivors equal exactly two AND the previous three rounds all tied on the same pair, auto-resolve in favor of the item earliest in the original cuisine deck.

- [ ] **Step 1: Write failing tests**

Append to `tests/bracket.test.js`:

```js
import { buildNextRound } from '../src/bracket.js';
// CUISINES isn't needed here; we pass an explicit deckOrder to keep the bracket logic self-contained.

function resolveAll(db, sid, picks) {
  // picks: [{ pairIndex, aPick, bPick }]
  for (const p of picks) {
    recordBracketVote(db, sid, { side: 'a', pairIndex: p.pairIndex, pick: p.aPick });
    recordBracketVote(db, sid, { side: 'b', pairIndex: p.pairIndex, pick: p.bPick });
  }
}

describe('buildNextRound — survivors, byes, completion', () => {
  it('returns done with the winner when only one item remains', () => {
    createRound(db, sid, 0, ['thai', 'sushi']);
    resolveAll(db, sid, [{ pairIndex: 0, aPick: 'thai', bPick: 'thai' }]);
    const r = buildNextRound(db, sid, ['pizza','thai','sushi']);  // deck order
    expect(r).toEqual({ done: true, winner: 'thai' });
  });

  it('produces the next round in survivor order (winner from each pair, in order)', () => {
    createRound(db, sid, 0, ['thai', 'sushi', 'pizza', 'burgers']);
    resolveAll(db, sid, [
      { pairIndex: 0, aPick: 'thai', bPick: 'thai' },     // thai wins
      { pairIndex: 1, aPick: 'pizza', bPick: 'burgers' }, // tie → both
    ]);
    const r = buildNextRound(db, sid, ['pizza','thai','sushi','burgers']);
    expect(r.done).toBe(false);
    expect(r.round.map(p => [p.itemA, p.itemB])).toEqual([
      ['thai', 'pizza'],
      ['burgers', null],   // bye
    ]);
  });

  it('skips the bracket entirely if overlap had only one item (single-pair bye)', () => {
    createRound(db, sid, 0, ['thai']);
    const r = buildNextRound(db, sid, ['pizza','thai']);
    expect(r).toEqual({ done: true, winner: 'thai' });
  });
});

describe('buildNextRound — loop break on the final pair', () => {
  it('after three consecutive ties on (thai, sushi), winner = earlier in deck (thai)', () => {
    const deck = ['pizza', 'thai', 'sushi'];  // thai before sushi

    // Round 0: (thai, sushi) → tie
    createRound(db, sid, 0, ['thai', 'sushi']);
    resolveAll(db, sid, [{ pairIndex: 0, aPick: 'thai', bPick: 'sushi' }]);
    let r = buildNextRound(db, sid, deck);
    expect(r.done).toBe(false);  // round 1 created
    // Round 1: (thai, sushi) → tie
    resolveAll(db, sid, [{ pairIndex: 0, aPick: 'thai', bPick: 'sushi' }]);
    r = buildNextRound(db, sid, deck);
    expect(r.done).toBe(false);  // round 2 created
    // Round 2: (thai, sushi) → tie
    resolveAll(db, sid, [{ pairIndex: 0, aPick: 'thai', bPick: 'sushi' }]);
    r = buildNextRound(db, sid, deck);
    // Three consecutive ties on the same final pair: auto-resolve. Thai is earlier in deck.
    expect(r).toEqual({ done: true, winner: 'thai' });
  });

  it('does not auto-resolve if a non-final-pair round broke the streak', () => {
    const deck = ['a', 'b', 'c'];
    createRound(db, sid, 0, ['a', 'b', 'c']);                  // pairs: (a,b), (c,bye→c)
    resolveAll(db, sid, [{ pairIndex: 0, aPick: 'a', bPick: 'b' }]);  // tie on (a,b); c byes
    // Survivors: a, b, c → next round pairs: (a,b), (c,bye)
    let r = buildNextRound(db, sid, deck);
    expect(r.done).toBe(false);
    resolveAll(db, sid, [{ pairIndex: 0, aPick: 'a', bPick: 'b' }]);  // tie again
    r = buildNextRound(db, sid, deck);
    expect(r.done).toBe(false);
    resolveAll(db, sid, [{ pairIndex: 0, aPick: 'a', bPick: 'b' }]);  // tie again
    // Three ties on (a,b), but each round also had c. Survivors before this build = [a,b,c]. So this is not final-pair stalemate.
    r = buildNextRound(db, sid, deck);
    expect(r.done).toBe(false);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- bracket`
Expected: `buildNextRound` undefined.

- [ ] **Step 3: Implement**

Append to `src/bracket.js`:

```js
function survivorsFromRound(rows) {
  // rows in pair_index order. For a_wins → [item_a]; b_wins → [item_b]; both → [item_a, item_b].
  const out = [];
  for (const p of rows) {
    if (p.outcome === 'a_wins') out.push(p.itemA);
    else if (p.outcome === 'b_wins') out.push(p.itemB);
    else if (p.outcome === 'both') out.push(p.itemA, p.itemB);
    else throw new Error(`buildNextRound called with unresolved pair ${p.pairIndex}`);
  }
  return out;
}

function deckIndex(deckOrder, item) {
  const i = deckOrder.indexOf(item);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}

function lastThreeTiesOnSameFinalPair(db, sessionId) {
  // Walk back through rounds. Each round must have exactly one pair, that pair must have outcome='both',
  // and the (item_a, item_b) must match across all three rounds.
  const rounds = db.prepare(
    "SELECT round_index, pair_index, item_a, item_b, outcome FROM bracket_round WHERE session_id=? ORDER BY round_index DESC"
  ).all(sessionId);
  // Group by round_index
  const byRound = new Map();
  for (const r of rounds) {
    if (!byRound.has(r.round_index)) byRound.set(r.round_index, []);
    byRound.get(r.round_index).push(r);
  }
  const sortedRoundIndexes = Array.from(byRound.keys()).sort((x, y) => y - x);  // newest first
  if (sortedRoundIndexes.length < 3) return null;
  const checkRounds = sortedRoundIndexes.slice(0, 3).map(i => byRound.get(i));
  if (!checkRounds.every(r => r.length === 1 && r[0].outcome === 'both')) return null;
  const first = checkRounds[0][0];
  if (!checkRounds.every(r => r[0].item_a === first.item_a && r[0].item_b === first.item_b)) return null;
  return { itemA: first.item_a, itemB: first.item_b };
}

export function buildNextRound(db, sessionId, deckOrder) {
  const latest = latestRoundIndex(db, sessionId);
  if (latest === null) throw new Error('buildNextRound: no rounds exist yet');
  const pairs = getRoundPairs(db, sessionId, latest);
  const survivors = survivorsFromRound(pairs);

  if (survivors.length === 0) throw new Error('buildNextRound: no survivors (shouldn\'t happen)');
  if (survivors.length === 1) return { done: true, winner: survivors[0] };

  // Loop break: exactly 2 survivors AND last 3 rounds were each a single 'both' on the same pair.
  if (survivors.length === 2) {
    const stale = lastThreeTiesOnSameFinalPair(db, sessionId);
    if (stale && new Set([stale.itemA, stale.itemB]).size === 2 &&
        survivors.includes(stale.itemA) && survivors.includes(stale.itemB)) {
      const winner = deckIndex(deckOrder, stale.itemA) <= deckIndex(deckOrder, stale.itemB)
        ? stale.itemA : stale.itemB;
      return { done: true, winner };
    }
  }

  const nextRoundIndex = latest + 1;
  const round = createRound(db, sessionId, nextRoundIndex, survivors);
  return { done: false, round };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- bracket`
Expected: all bracket tests pass.

- [ ] **Step 5: Commit**

```bash
jj commit -m "bracket: buildNextRound with survivor ordering and final-pair loop break"
```

---

## Task 6: Routes — extended /api/state, partner-done plumbing, no cuisine instant match

**Files:**
- Modify: `src/routes.js`
- Modify: `tests/routes.test.js`
- Modify: `tests/helpers.js` (only if existing stub omits anything new — it does not for this task)

- [ ] **Step 1: Update tests for the new state shape**

Replace the `GET /api/state` block in `tests/routes.test.js` and update the swipe test that asserted matched:true on cuisines:

```js
describe('GET /api/state', () => {
  it('returns the cuisines deck with stage=swipe, partnerDone=false, bracket=null', async () => {
    const res = await request(app).get('/api/state').set('Cookie', 'side=a');
    expect(res.status).toBe(200);
    expect(res.body.phase).toBe('cuisines');
    expect(res.body.stage).toBe('swipe');
    expect(res.body.deck.length).toBeGreaterThan(0);
    expect(res.body.partnerDone).toBe(false);
    expect(res.body.bracket).toBeNull();
  });

  it('returns partnerDone=true once the other side has swiped every cuisine', async () => {
    const { CUISINES } = await import('../src/cuisines.js');
    for (const c of CUISINES) {
      await request(app).post('/api/swipe').set('Cookie', 'side=b').send({ itemId: c.id, direction: 'left' });
    }
    const res = await request(app).get('/api/state').set('Cookie', 'side=a');
    expect(res.body.partnerDone).toBe(true);
  });
});

describe('POST /api/swipe — cuisines phase no longer instant-matches', () => {
  it('returns matched:false even when both sides swipe right on the same cuisine', async () => {
    await request(app).post('/api/swipe').set('Cookie', 'side=a').send({ itemId: 'thai', direction: 'right' });
    const res = await request(app).post('/api/swipe').set('Cookie', 'side=b').send({ itemId: 'thai', direction: 'right' });
    expect(res.body.matched).toBe(false);
  });
});
```

The existing test "emits match SSE and advances phase when both swipe right" must be removed/replaced — cuisine matches no longer instant-resolve. Keep restaurant-match tests intact.

- [ ] **Step 2: Verify failure**

Run: `npm test -- routes`
Expected: state shape failure, swipe match-flow failure.

- [ ] **Step 3: Update routes.js**

In `src/routes.js`, replace the `GET /api/state` handler:

```js
import {
  // existing imports plus:
  bothDoneSwipingCuisines,
} from './session.js';
import { getCurrentPair } from './bracket.js';

// ... inside makeRouter, replace the existing /api/state handler:
router.get('/api/state', requireSide, async (req, res) => {
  const session = ensureSession(db);
  const deck = await buildDeck(places, session);
  const mySwipes = getSwipes(db, session.id, session.phase).filter(s => s.side === req.side);

  let stage = null;
  let bracket = null;
  let partnerDone = false;

  if (session.phase === 'cuisines') {
    stage = session.cuisineStage;
    const otherSide = req.side === 'a' ? 'b' : 'a';
    const otherSwipes = getSwipes(db, session.id, 'cuisines').filter(s => s.side === otherSide);
    partnerDone = otherSwipes.length >= CUISINES.length;
    if (stage === 'bracket') {
      const cur = getCurrentPair(db, session.id);
      bracket = {
        roundIndex: cur ? cur.roundIndex : 0,
        currentPair: cur
          ? { pairIndex: cur.pairIndex, a: cuisineById(cur.itemA), b: cur.itemB ? cuisineById(cur.itemB) : null }
          : null,
        myVote: cur ? (db.prepare(
          'SELECT pick FROM bracket_vote WHERE session_id=? AND round_index=? AND pair_index=? AND side=?'
        ).get(session.id, cur.roundIndex, cur.pairIndex, req.side)?.pick ?? null) : null,
      };
    }
  }

  res.json({
    phase: session.phase,
    stage,
    matchedCuisine: session.matchedCuisine,
    matchedRestaurant: session.matchedRestaurantJson ? JSON.parse(session.matchedRestaurantJson) : null,
    deck,
    mySwipes,
    partnerOnline: hub.isOnline(req.side === 'a' ? 'b' : 'a'),
    partnerDone,
    bracket,
    mySide: req.side,
    myName: sideNames[req.side],
    partnerName: sideNames[req.side === 'a' ? 'b' : 'a'],
  });
});
```

Update the swipe handler — cuisine matches do not advance; restaurants behave as before:

```js
router.post('/api/swipe', requireSide, async (req, res) => {
  const { itemId, direction } = req.body ?? {};
  if (direction !== 'left' && direction !== 'right') {
    return res.status(400).json({ error: 'direction must be left or right' });
  }
  if (typeof itemId !== 'string' || !itemId) {
    return res.status(400).json({ error: 'itemId required' });
  }
  const session = ensureSession(db);

  if (session.phase === 'cuisines' && session.cuisineStage === 'bracket') {
    return res.status(400).json({ error: 'cannot swipe during bracket stage; use /api/bracket-vote' });
  }

  const result = recordSwipe(db, {
    sessionId: session.id, side: req.side, phase: session.phase, itemId, direction,
  });

  if (session.phase === 'cuisines') {
    // Did this swipe complete the side's deck?
    const mineCount = getSwipes(db, session.id, 'cuisines').filter(s => s.side === req.side).length;
    if (mineCount === CUISINES.length) {
      hub.broadcast({ type: 'partner-done', side: req.side, swipedCount: mineCount });
    }
    // Both done? Transition to bracket or directly to restaurants (1-overlap) or no-overlap (0).
    if (bothDoneSwipingCuisines(db, session.id, CUISINES.map(c => c.id))) {
      await transitionFromSwipeToBracket({ db, session, places, hub });
    }
    return res.json({ matched: false });
  }

  // restaurants phase: instant match flow unchanged from the existing implementation
  if (!result.matched) return res.json({ matched: false });
  const restaurants = await restaurantsForCuisine(places, session.matchedCuisine);
  const matchItem = restaurants.find(r => r.id === itemId);
  if (!matchItem) return res.status(404).json({ error: 'unknown restaurant' });
  advanceOnMatch(db, { sessionId: session.id, phase: 'restaurants', match: matchItem });
  hub.broadcast({ type: 'match', phase: 'restaurants', item: matchItem });
  res.json({ matched: true });
});
```

Add a transition helper at module scope (above `makeRouter`):

```js
import {
  computeCuisineOverlap, setCuisineStage,
} from './session.js';
import { createRound } from './bracket.js';

async function transitionFromSwipeToBracket({ db, session, places, hub }) {
  const overlap = computeCuisineOverlap(db, session.id, CUISINES.map(c => c.id));
  if (overlap.length === 0) {
    hub.broadcast({ type: 'stage-change', stage: 'no-overlap' });
    return;
  }
  if (overlap.length === 1) {
    const matched = cuisineById(overlap[0]);
    advanceOnMatch(db, { sessionId: session.id, phase: 'cuisines', match: matched });
    const restaurants = await restaurantsForCuisine(places, matched.id);
    hub.broadcast({ type: 'match', phase: 'cuisines', item: matched });
    hub.broadcast({ type: 'phase-change', phase: 'restaurants', deck: restaurants });
    return;
  }
  createRound(db, session.id, 0, overlap);
  setCuisineStage(db, session.id, 'bracket');
  const cur = getCurrentPair(db, session.id);
  hub.broadcast({
    type: 'stage-change',
    stage: 'bracket',
    bracket: {
      roundIndex: cur.roundIndex,
      currentPair: { pairIndex: cur.pairIndex, a: cuisineById(cur.itemA), b: cur.itemB ? cuisineById(cur.itemB) : null },
    },
  });
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- routes`
Expected: all updated route tests pass; remaining flows untouched.

- [ ] **Step 5: Commit**

```bash
jj commit -m "routes: stage-aware /api/state and /api/swipe; transition into bracket on both-done"
```

---

## Task 7: Routes — POST /api/bracket-vote

**Files:**
- Modify: `src/routes.js`
- Modify: `tests/routes.test.js`

- [ ] **Step 1: Write failing tests**

Append to `tests/routes.test.js`:

```js
describe('POST /api/bracket-vote', () => {
  async function getIntoBracketWithOverlap(items) {
    // helper: import CUISINES; A right-swipes the overlap items, left-swipes the rest.
    // B does the same. Both finish, transition fires, bracket round 0 created.
    const { CUISINES } = await import('../src/cuisines.js');
    for (const c of CUISINES) {
      const dir = items.includes(c.id) ? 'right' : 'left';
      await request(app).post('/api/swipe').set('Cookie', 'side=a').send({ itemId: c.id, direction: dir });
      await request(app).post('/api/swipe').set('Cookie', 'side=b').send({ itemId: c.id, direction: dir });
    }
  }

  it('rejects vote before bracket stage', async () => {
    const res = await request(app).post('/api/bracket-vote').set('Cookie', 'side=a')
      .send({ pairIndex: 0, pick: 'thai' });
    expect(res.status).toBe(400);
  });

  it('records vote and returns matched:false on first side', async () => {
    await getIntoBracketWithOverlap(['thai', 'pizza']);
    const res = await request(app).post('/api/bracket-vote').set('Cookie', 'side=a')
      .send({ pairIndex: 0, pick: 'thai' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ resolved: false });
  });

  it('resolves when both sides vote the same; advances phase if bracket is done', async () => {
    await getIntoBracketWithOverlap(['thai', 'pizza']);
    // Round 0 has one pair (pizza, thai) since CUISINES has pizza before thai (deck order overlap).
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=a').send({ pairIndex: 0, pick: 'thai' });
    const res = await request(app).post('/api/bracket-vote').set('Cookie', 'side=b').send({ pairIndex: 0, pick: 'thai' });
    expect(res.body.resolved).toBe(true);
    // Single-pair round resolved → bracket done → phase advances
    const row = db.prepare('SELECT phase, matched_cuisine FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('restaurants');
    expect(row.matched_cuisine).toBe('thai');
  });

  it('rejects malformed pick', async () => {
    await getIntoBracketWithOverlap(['thai', 'pizza']);
    const res = await request(app).post('/api/bracket-vote').set('Cookie', 'side=a')
      .send({ pairIndex: 0, pick: 'mexican' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- routes`
Expected: 404 on the endpoint or method-not-found errors.

- [ ] **Step 3: Implement**

Inside `makeRouter`, add:

```js
import { recordBracketVote, buildNextRound, getCurrentPair as _ignoredAlreadyImported } from './bracket.js';

router.post('/api/bracket-vote', requireSide, async (req, res) => {
  const { pairIndex, pick } = req.body ?? {};
  if (typeof pairIndex !== 'number' || typeof pick !== 'string') {
    return res.status(400).json({ error: 'pairIndex (number) and pick (string) required' });
  }
  const session = ensureSession(db);
  if (session.phase !== 'cuisines' || session.cuisineStage !== 'bracket') {
    return res.status(400).json({ error: 'bracket vote only valid in cuisines bracket stage' });
  }
  let result;
  try {
    result = recordBracketVote(db, session.id, { side: req.side, pairIndex, pick });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  hub.broadcast({ type: 'bracket-vote-cast', side: req.side, pairIndex });

  if (!result.resolved) return res.json({ resolved: false });

  hub.broadcast({
    type: 'bracket-pair-resolved', pairIndex,
    outcome: result.outcome, winner: result.winners.length === 1 ? result.winners[0] : null,
  });

  // If any pair in this round is still pending, that's it.
  if (getCurrentPair(db, session.id)) return res.json({ resolved: true });

  // Round complete — advance the bracket.
  const deckOrder = CUISINES.map(c => c.id);
  const next = buildNextRound(db, session.id, deckOrder);

  if (next.done) {
    const matched = cuisineById(next.winner);
    advanceOnMatch(db, { sessionId: session.id, phase: 'cuisines', match: matched });
    const restaurants = await restaurantsForCuisine(places, matched.id);
    hub.broadcast({ type: 'match', phase: 'cuisines', item: matched });
    hub.broadcast({ type: 'phase-change', phase: 'restaurants', deck: restaurants });
    return res.json({ resolved: true, done: true });
  }

  const cur = getCurrentPair(db, session.id);
  hub.broadcast({
    type: 'bracket-round-start',
    roundIndex: cur.roundIndex,
    currentPair: { pairIndex: cur.pairIndex, a: cuisineById(cur.itemA), b: cur.itemB ? cuisineById(cur.itemB) : null },
  });
  res.json({ resolved: true });
});
```

- [ ] **Step 4: Run tests**

Run: `npm test -- routes`
Expected: all bracket-vote route tests pass.

- [ ] **Step 5: Commit**

```bash
jj commit -m "routes: POST /api/bracket-vote with round/phase advancement"
```

---

## Task 8: Routes — stage-aware /api/reset

**Files:**
- Modify: `src/routes.js`
- Modify: `tests/routes.test.js`

- [ ] **Step 1: Write failing tests**

Append to `tests/routes.test.js`:

```js
describe('POST /api/reset — stage-aware in cuisines phase', () => {
  async function getIntoBracket(items) {
    const { CUISINES } = await import('../src/cuisines.js');
    for (const c of CUISINES) {
      const dir = items.includes(c.id) ? 'right' : 'left';
      await request(app).post('/api/swipe').set('Cookie', 'side=a').send({ itemId: c.id, direction: dir });
      await request(app).post('/api/swipe').set('Cookie', 'side=b').send({ itemId: c.id, direction: dir });
    }
  }

  it('scope=phase during stage=bracket clears bracket data but keeps cuisine swipes', async () => {
    await getIntoBracket(['thai', 'pizza', 'sushi']);   // 3+ overlap → real bracket
    expect(db.prepare('SELECT COUNT(*) AS n FROM bracket_round').get().n).toBeGreaterThan(0);
    const swipeCountBefore = db.prepare("SELECT COUNT(*) AS n FROM swipe WHERE phase='cuisines'").get().n;
    const res = await request(app).post('/api/reset').set('Cookie', 'side=a').send({ scope: 'phase' });
    expect(res.status).toBe(200);
    // Cuisine swipes preserved
    expect(db.prepare("SELECT COUNT(*) AS n FROM swipe WHERE phase='cuisines'").get().n).toBe(swipeCountBefore);
    // Bracket data cleared, then rebuilt fresh from overlap → round 0 exists again
    expect(db.prepare('SELECT MAX(round_index) AS r FROM bracket_round').get().r).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bracket_vote').get().n).toBe(0);
  });

  it('scope=phase during stage=swipe clears cuisine swipes (existing behavior)', async () => {
    await request(app).post('/api/swipe').set('Cookie', 'side=a').send({ itemId: 'thai', direction: 'right' });
    const res = await request(app).post('/api/reset').set('Cookie', 'side=a').send({ scope: 'phase' });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM swipe').get().n).toBe(0);
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- routes`
Expected: bracket-clear test fails (existing reset still wipes swipes).

- [ ] **Step 3: Update the reset handler**

Replace the `phase` branch of the existing `/api/reset` handler:

```js
if (scope === 'phase') {
  if (session.phase === 'cuisines' && session.cuisineStage === 'bracket') {
    // Bracket-only reset: clear votes + rounds; rebuild round 0 from the same overlap.
    db.prepare('DELETE FROM bracket_vote WHERE session_id=?').run(session.id);
    db.prepare('DELETE FROM bracket_round WHERE session_id=?').run(session.id);
    const overlap = computeCuisineOverlap(db, session.id, CUISINES.map(c => c.id));
    if (overlap.length >= 2) {
      createRound(db, session.id, 0, overlap);
      const cur = getCurrentPair(db, session.id);
      hub.broadcast({
        type: 'phase-reset', phase: 'cuisines',
        bracket: { roundIndex: cur.roundIndex,
                   currentPair: { pairIndex: cur.pairIndex,
                                  a: cuisineById(cur.itemA),
                                  b: cur.itemB ? cuisineById(cur.itemB) : null } },
      });
    } else {
      // Pathological — bracket existed but overlap shrunk? Fall through to swipe stage.
      setCuisineStage(db, session.id, 'swipe');
      hub.broadcast({ type: 'phase-reset', phase: 'cuisines', deck: CUISINES });
    }
    return res.json({ ok: true });
  }

  resetPhase(db, session.id, session.phase);
  let deck;
  if (session.phase === 'cuisines') deck = CUISINES;
  else if (session.phase === 'restaurants') deck = await restaurantsForCuisine(places, session.matchedCuisine);
  else deck = [];
  hub.broadcast({ type: 'phase-reset', phase: session.phase, deck });
  return res.json({ ok: true });
}
```

`session` reset path is unchanged.

- [ ] **Step 4: Run tests**

Run: `npm test -- routes`
Expected: all reset tests pass.

- [ ] **Step 5: Commit**

```bash
jj commit -m "routes: phase-reset preserves cuisine swipes during bracket stage"
```

---

## Task 9: Integration test — full bracket flow

**Files:**
- Modify: `tests/integration.test.js`

- [ ] **Step 1: Add failing tests**

Append to `tests/integration.test.js` (keep the existing flow tests intact):

```js
describe('full flow — cuisine bracket', () => {
  async function swipeAll(side, swipes) {
    for (const [itemId, direction] of swipes) {
      await request(app).post('/api/swipe').set('Cookie', `side=${side}`).send({ itemId, direction });
    }
  }
  async function swipeAllCuisines(side, rightItems) {
    const { CUISINES } = await import('../src/cuisines.js');
    const swipes = CUISINES.map(c => [c.id, rightItems.includes(c.id) ? 'right' : 'left']);
    await swipeAll(side, swipes);
  }

  it('0 overlap → stage-change no-overlap event', async () => {
    await swipeAllCuisines('a', ['thai']);
    await swipeAllCuisines('b', ['pizza']);
    // Session still in cuisines phase, stage=swipe, but the server should have broadcast no-overlap.
    const row = db.prepare('SELECT phase, cuisine_stage FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('cuisines');
    expect(row.cuisine_stage).toBe('swipe');
  });

  it('1 overlap → advances to restaurants directly', async () => {
    await swipeAllCuisines('a', ['thai']);
    await swipeAllCuisines('b', ['thai']);
    const row = db.prepare('SELECT phase, matched_cuisine FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('restaurants');
    expect(row.matched_cuisine).toBe('thai');
  });

  it('3 overlap with a tie advances through two rounds and lands in restaurants', async () => {
    // Both right-swipe pizza, thai, sushi (in deck order). Bracket round 0: (pizza, thai), (sushi bye).
    await swipeAllCuisines('a', ['pizza', 'thai', 'sushi']);
    await swipeAllCuisines('b', ['pizza', 'thai', 'sushi']);
    let row = db.prepare('SELECT cuisine_stage FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.cuisine_stage).toBe('bracket');
    // Round 0 pair 0: tie (pizza vs thai). After both vote differently → both advance.
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=a').send({ pairIndex: 0, pick: 'pizza' });
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=b').send({ pairIndex: 0, pick: 'thai' });
    // Round 1: survivors [pizza, thai, sushi] (sushi auto-byed in round 0) → pairs (pizza, thai), (sushi bye).
    // Resolve round 1 pair 0 in favor of pizza:
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=a').send({ pairIndex: 0, pick: 'pizza' });
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=b').send({ pairIndex: 0, pick: 'pizza' });
    // Round 2: survivors [pizza, sushi] → one pair (pizza, sushi). Resolve to pizza:
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=a').send({ pairIndex: 0, pick: 'pizza' });
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=b').send({ pairIndex: 0, pick: 'pizza' });
    row = db.prepare('SELECT phase, matched_cuisine FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('restaurants');
    expect(row.matched_cuisine).toBe('pizza');
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `npm test -- integration`
Expected: passing flows continue passing, new ones reveal anything still off in route wiring.

- [ ] **Step 3: Fix any wiring discovered**

If tests fail, the most likely culprits are: a missing `import { createRound }` in routes.js, or `transitionFromSwipeToBracket` not invoked because `bothDoneSwipingCuisines` is reached before the swipe is committed. Trace and fix.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: full suite green.

- [ ] **Step 5: Commit**

```bash
jj commit -m "tests: integration coverage for 0/1/3-overlap cuisine bracket"
```

---

## Task 10: Frontend — index.html scaffold for new views

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Edit the HTML**

Replace the `<main id="app">` block:

```html
<main id="app">
  <section id="view-cuisines" class="view deck" hidden>
    <div class="card-stack" data-deck="cuisines"></div>
    <div class="hint"><span class="hint-no">← no</span> · <span class="hint-yes">yes →</span></div>
    <button type="button" class="btn-secondary deck-reset" data-action="reset-session">Start over</button>
  </section>

  <section id="view-cuisines-waiting" class="view" hidden>
    <h2 class="waiting-title">Waiting for <span data-partner-name>your partner</span>…</h2>
    <p class="waiting-meta" data-waiting-meta></p>
    <button type="button" class="btn-secondary" data-action="reset-session">Start over</button>
  </section>

  <section id="view-bracket" class="view" hidden>
    <h2 class="bracket-title">Round <span data-bracket-round>1</span></h2>
    <div class="bracket-pair">
      <button type="button" class="bracket-card" data-bracket-pick="a"></button>
      <div class="bracket-vs">vs</div>
      <button type="button" class="bracket-card" data-bracket-pick="b"></button>
    </div>
    <p class="bracket-waiting" data-bracket-waiting hidden>Waiting for <span data-partner-name>partner</span>…</p>
    <button type="button" class="btn-secondary deck-reset" data-action="reset-phase">Restart bracket</button>
  </section>

  <section id="view-no-overlap" class="view" hidden>
    <h2 class="no-overlap-title">No overlap</h2>
    <p>You didn't both swipe right on the same cuisine.</p>
    <button type="button" class="btn-primary" data-action="reset-phase">Swipe again</button>
    <button type="button" class="btn-secondary" data-action="reset-session">Start over</button>
  </section>

  <section id="view-restaurants" class="view deck" hidden>
    <div class="card-stack" data-deck="restaurants"></div>
    <div class="hint"><span class="hint-no">← no</span> · <span class="hint-yes">yes →</span></div>
    <button type="button" class="btn-secondary deck-reset" data-action="reset-session">Start over</button>
  </section>

  <section id="view-match" class="view" hidden>
    <div class="match-banner">🎉 it's a match</div>
    <button type="button" class="btn-primary" data-action="reset-session">Start over</button>
    <div class="match-card" data-match></div>
  </section>

  <section id="view-empty" class="view" hidden>
    <p data-empty-message></p>
    <button type="button" class="btn-primary" data-action="reset-phase">Try this round again</button>
    <button type="button" class="btn-secondary" data-action="reset-session">Start over</button>
  </section>
</main>
```

- [ ] **Step 2: Commit**

```bash
jj commit -m "frontend: scaffold waiting, bracket, no-overlap views"
```

---

## Task 11: Frontend — CSS for bracket and waiting views

**Files:**
- Modify: `public/app.css`

- [ ] **Step 1: Append to app.css**

```css
.waiting-title { font-size: 1.6rem; font-weight: 700; text-align: center; margin: 0; }
.waiting-meta { color: #aaa; text-align: center; margin: 0; }

.no-overlap-title { font-size: 1.8rem; font-weight: 700; text-align: center; color: #f87171; margin: 0; }

.bracket-title { font-size: 1.2rem; font-weight: 600; color: #aaa; margin: 0; text-align: center; }
.bracket-pair {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: stretch;
  gap: 1rem;
  width: 100%;
}
@media (max-width: 600px) {
  .bracket-pair { grid-template-columns: 1fr; grid-auto-rows: auto; }
  .bracket-vs { order: 0; }
}
.bracket-card {
  background: #222;
  border: 0;
  border-radius: 1.5rem;
  padding: 2rem 1rem;
  min-height: 38vh;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.5rem;
  font: inherit; color: inherit; cursor: pointer;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  transition: transform 0.15s ease, opacity 0.2s ease;
}
.bracket-card:hover { transform: translateY(-2px); }
.bracket-card[data-state="picked"] { outline: 3px solid #4cf; }
.bracket-card[data-state="dimmed"] { opacity: 0.3; }
.bracket-card .emoji { font-size: 4.5rem; }
.bracket-card .name { font-size: 1.4rem; font-weight: 600; }
.bracket-vs {
  align-self: center; justify-self: center;
  font-size: 1.1rem; font-weight: 700; color: #666; letter-spacing: 0.1em;
}
.bracket-waiting { color: #aaa; text-align: center; margin: 0; }
```

- [ ] **Step 2: Commit**

```bash
jj commit -m "frontend: bracket pair grid + waiting/no-overlap styles"
```

---

## Task 12: Frontend — app.js handling of new state + SSE events

**Files:**
- Modify: `public/app.js`

- [ ] **Step 1: Update views map and add render functions**

Near the top of `public/app.js`, extend `views`:

```js
const views = {
  cuisines: $('#view-cuisines'),
  cuisinesWaiting: $('#view-cuisines-waiting'),
  bracket: $('#view-bracket'),
  noOverlap: $('#view-no-overlap'),
  restaurants: $('#view-restaurants'),
  match: $('#view-match'),
  empty: $('#view-empty'),
};
```

Update `PHASE_LABELS` to include bracket sub-state and add render helpers:

```js
const PHASE_LABELS = {
  cuisines: 'Choosing a cuisine',
  restaurants: 'Choosing a restaurant',
  done: 'Matched!',
};

function phaseLabel() {
  if (state.phase === 'cuisines' && state.stage === 'bracket') return 'Cuisine bracket';
  if (state.phase === 'cuisines' && state.partnerDone === false && state.mySwipes.length >= state.deck.length) {
    return `Waiting for ${state.partnerName ?? 'partner'}`;
  }
  return PHASE_LABELS[state.phase] ?? state.phase;
}

function setStatus() {
  const me = state.myName ?? window.SIDE_NAMES?.[SIDE] ?? SIDE.toUpperCase();
  const partner = state.partnerName ?? window.SIDE_NAMES?.[SIDE === 'a' ? 'b' : 'a'] ?? (SIDE === 'a' ? 'B' : 'A');
  $('[data-phase]').textContent = phaseLabel();
  $('[data-partner]').textContent = `${me} · ${partner} ${state.partnerOnline ? '🟢' : '⚫'}`;
}

function renderBracket() {
  if (!state.bracket || !state.bracket.currentPair) return;
  $('[data-bracket-round]').textContent = String((state.bracket.roundIndex ?? 0) + 1);
  const { a, b, pairIndex } = state.bracket.currentPair;
  const cardA = $('[data-bracket-pick="a"]');
  const cardB = $('[data-bracket-pick="b"]');
  cardA.innerHTML = `<div class="emoji">${a.emoji}</div><div class="name">${a.name}</div>`;
  cardB.innerHTML = b ? `<div class="emoji">${b.emoji}</div><div class="name">${b.name}</div>` : '<div class="name">(bye)</div>';
  cardA.dataset.itemId = a.id;
  cardB.dataset.itemId = b ? b.id : '';
  cardA.dataset.pairIndex = String(pairIndex);
  cardB.dataset.pairIndex = String(pairIndex);
  cardA.dataset.state = state.bracket.myVote === a.id ? 'picked' : (state.bracket.myVote ? 'dimmed' : '');
  cardB.dataset.state = state.bracket.myVote && b && state.bracket.myVote === b.id ? 'picked' : (state.bracket.myVote && b ? 'dimmed' : '');
  $('[data-bracket-waiting]').hidden = !state.bracket.myVote;
  if (state.partnerName) {
    for (const el of document.querySelectorAll('[data-partner-name]')) el.textContent = state.partnerName;
  }
}

function renderWaiting() {
  const swipedCount = state.mySwipes.length;
  const total = state.deck.length;
  $('[data-waiting-meta]').textContent = `You finished ${swipedCount}/${total}. They're still swiping.`;
  if (state.partnerName) {
    for (const el of document.querySelectorAll('[data-partner-name]')) el.textContent = state.partnerName;
  }
}
```

- [ ] **Step 2: Update applyState to route to the new views**

Replace the existing `applyState` body:

```js
function applyState() {
  setStatus();
  if (state.phase === 'done' && state.matchedRestaurant) {
    renderMatch();
    showView('match');
    return;
  }

  if (state.phase === 'cuisines') {
    if (state.stage === 'bracket') {
      renderBracket();
      showView('bracket');
      return;
    }
    // stage === 'swipe' below
    const mySwipedIds = new Set(state.mySwipes.map(s => s.itemId));
    const remaining = state.deck.filter(item => !mySwipedIds.has(item.id));
    if (remaining.length === 0) {
      renderWaiting();
      showView('cuisinesWaiting');
      return;
    }
    renderDeck(views.cuisines, remaining, renderCuisineCard);
    attachSwipe(views.cuisines.querySelector('.card-stack'));
    showView('cuisines');
    return;
  }

  if (state.phase === 'restaurants') {
    const mySwipedIds = new Set(state.mySwipes.map(s => s.itemId));
    const remaining = state.deck.filter(item => !mySwipedIds.has(item.id));
    if (remaining.length === 0) {
      const msg = !state.partnerOnline ? 'waiting for partner…' : `you're done — no overlap yet`;
      $('[data-empty-message]').textContent = msg;
      showView('empty');
      return;
    }
    renderDeck(views.restaurants, remaining, renderRestaurantCard);
    attachSwipe(views.restaurants.querySelector('.card-stack'));
    showView('restaurants');
  }
}
```

- [ ] **Step 3: Handle new SSE events**

Update `handleEvent`:

```js
async function handleEvent(event) {
  if (!state) { await fetchState(); return; }

  if (event.type === 'partner-online') { state.partnerOnline = event.online; setStatus(); return; }
  if (event.type === 'partner-done')   { state.partnerDone = true; setStatus(); applyState(); return; }

  if (event.type === 'stage-change') {
    if (event.stage === 'no-overlap') { state.phase = 'cuisines'; state.stage = 'swipe'; showView('noOverlap'); return; }
    if (event.stage === 'bracket')    { await fetchState(); return; }
  }

  if (event.type === 'bracket-round-start' || event.type === 'bracket-pair-resolved' || event.type === 'bracket-vote-cast') {
    await fetchState();
    return;
  }

  if (event.type === 'phase-change') { await fetchState(); return; }

  if (event.type === 'match' && event.phase === 'cuisines') {
    // server follows with phase-change carrying the deck; nothing to do here
    return;
  }
  if (event.type === 'match' && event.phase === 'restaurants') {
    state.phase = 'done'; state.matchedRestaurant = event.item;
    renderMatch(); showView('match'); return;
  }

  if (event.type === 'phase-reset' || event.type === 'session-reset') {
    await fetchState();
  }
}
```

- [ ] **Step 4: Add bracket-tap handler**

In the global click handler:

```js
document.addEventListener('click', async (e) => {
  const bracketCard = e.target.closest('.bracket-card');
  if (bracketCard && bracketCard.dataset.itemId) {
    const pairIndex = Number(bracketCard.dataset.pairIndex);
    const pick = bracketCard.dataset.itemId;
    bracketCard.dataset.state = 'picked';
    if (state?.bracket) state.bracket.myVote = pick;
    $('[data-bracket-waiting]').hidden = false;
    await fetch(`/api/bracket-vote${Q}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairIndex, pick }),
    });
    return;
  }
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'reset-phase') postReset('phase');
  else if (action === 'reset-session') postReset('session');
});
```

- [ ] **Step 5: Commit**

```bash
jj commit -m "frontend: bracket view rendering, waiting view, bracket-vote tap handler"
```

---

## Task 13: README — document the new cuisines flow

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the "Two phases" description near the top**

Replace the existing two-phase description with:

```markdown
Two phases:

1. **Cuisines** — both partners blind-swipe through the full cuisine deck (right = yes, left = no). Once *both* are done, the server computes the overlap (cuisines both said yes to):
   - 0 overlap → "no overlap" screen with retry.
   - 1 overlap → that cuisine wins automatically.
   - 2+ overlap → **bracket**. Pair survivors in deck order, both partners tap their pick for each pair. Agree → other item out; disagree → both advance. Repeats until one remains. (Final-pair stalemate: after 3 consecutive ties, the earlier-in-deck item wins.)
2. **Restaurants** — server fetches restaurants for the matched cuisine, prepends your favorites, and serves them as a deck. First mutual right-swipe wins. Match screen shows photo, address, phone, Google Maps link.

Real-time over SSE: partner-online indicators, "partner is done swiping", bracket round transitions all push live.
```

- [ ] **Step 2: Commit**

```bash
jj commit -m "readme: describe new cuisines bracket flow"
```

---

## Task 14: Final lint + full test pass + manual smoke

- [ ] **Step 1: Lint**

Run: `npm run lint`
Expected: zero warnings/errors. Fix anything reported.

- [ ] **Step 2: Format**

Run: `npm run format`

- [ ] **Step 3: Full test**

Run: `npm test`
Expected: all tests pass (estimated 70+ tests after the additions).

- [ ] **Step 4: Manual smoke in two browser windows**

Local-only checklist after `npm run dev`:
- [ ] Both swipe all cuisines with multiple overlaps → bracket view appears on both
- [ ] Tap same card on both → other dims; round advances
- [ ] Tap different cards (tie) → both advance to next round
- [ ] Reach final winning cuisine → restaurants deck appears
- [ ] Mutual right-swipe a restaurant → match screen on both
- [ ] Both swipe with no overlap → "no overlap" screen with retry button works
- [ ] One swipes faster than the other → faster side sees waiting view
- [ ] `Restart bracket` button during bracket → keeps cuisine swipes, resets bracket to round 0
- [ ] `Start over` button → wipes session, back to fresh cuisines deck

- [ ] **Step 5: Commit any final fixes**

```bash
jj st  # if anything dirty:
jj commit -m "chore: lint and format pass"
```

---

## Spec coverage check

| Spec section | Implemented in |
|--------------|----------------|
| Stage 1a — solo swipe (no instant match) | Tasks 2, 6 |
| Stage 1b — bracket (entry condition, deck-order pairing) | Tasks 3, 4, 6 |
| 0/1/2+ overlap branching | Tasks 6, 9 |
| Bracket round mechanics + tie outcome | Tasks 4, 5 |
| Loop-break on final pair after 3 ties | Task 5 |
| `session.cuisine_stage` + bracket tables + migration | Task 1 |
| Extended `/api/state` shape (stage, partnerDone, bracket) | Task 6 |
| Stage-aware `/api/swipe` rejection | Task 6 |
| `POST /api/bracket-vote` | Task 7 |
| Stage-aware `/api/reset` (preserves swipes during bracket) | Task 8 |
| SSE events: partner-done, stage-change, bracket-round-start, bracket-pair-resolved, bracket-vote-cast | Tasks 6, 7 |
| Cuisine `match` event removed | Task 6 (handler stops emitting it) |
| Three new frontend views (waiting / bracket / no-overlap) | Tasks 10, 11, 12 |
| Bracket card layout responsive (side-by-side vs stacked) | Task 11 |
| Migration compat note (in-flight sessions lose place) | Task 1 (covered by ALTER TABLE + default) |
| Restaurants phase unchanged | Tasks 2, 6 |
