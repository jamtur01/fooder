import { describe, it, expect, beforeEach } from 'vitest';
import { pairItemsForRound } from '../src/bracket.js';
import { openDb } from '../src/db.js';
import {
  createRound, recordBracketVote, getCurrentPair, getRoundPairs, buildNextRound,
} from '../src/bracket.js';
import { createSession } from '../src/session.js';

let db, sid;
beforeEach(() => {
  db = openDb(':memory:');
  sid = createSession(db).id;
});

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

describe('createRound', () => {
  it('persists round 0 pairs from a deck-ordered overlap', () => {
    createRound(db, sid, 0, ['thai', 'sushi', 'pizza']);
    const rows = db.prepare(
      'SELECT round_index, pair_index, item_a, item_b, outcome FROM bracket_round WHERE session_id=? ORDER BY pair_index'
    ).all(sid);
    expect(rows).toEqual([
      { round_index: 0, pair_index: 0, item_a: 'thai', item_b: 'sushi', outcome: 'pending' },
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
    createRound(db, sid, 0, ['thai']);
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

function resolveAll(db, sid, picks) {
  for (const p of picks) {
    recordBracketVote(db, sid, { side: 'a', pairIndex: p.pairIndex, pick: p.aPick });
    recordBracketVote(db, sid, { side: 'b', pairIndex: p.pairIndex, pick: p.bPick });
  }
}

describe('buildNextRound — survivors, byes, completion', () => {
  it('returns done with the winner when only one item remains', () => {
    createRound(db, sid, 0, ['thai', 'sushi']);
    resolveAll(db, sid, [{ pairIndex: 0, aPick: 'thai', bPick: 'thai' }]);
    const r = buildNextRound(db, sid, ['pizza','thai','sushi']);
    expect(r).toEqual({ done: true, winner: 'thai' });
  });

  it('produces the next round in survivor order (winner from each pair, in order)', () => {
    createRound(db, sid, 0, ['thai', 'sushi', 'pizza', 'burgers']);
    resolveAll(db, sid, [
      { pairIndex: 0, aPick: 'thai', bPick: 'thai' },
      { pairIndex: 1, aPick: 'pizza', bPick: 'burgers' },
    ]);
    const r = buildNextRound(db, sid, ['pizza','thai','sushi','burgers']);
    expect(r.done).toBe(false);
    expect(r.round.map(p => [p.itemA, p.itemB])).toEqual([
      ['thai', 'pizza'],
      ['burgers', null],
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
    const deck = ['pizza', 'thai', 'sushi'];

    createRound(db, sid, 0, ['thai', 'sushi']);
    resolveAll(db, sid, [{ pairIndex: 0, aPick: 'thai', bPick: 'sushi' }]);
    let r = buildNextRound(db, sid, deck);
    expect(r.done).toBe(false);
    resolveAll(db, sid, [{ pairIndex: 0, aPick: 'thai', bPick: 'sushi' }]);
    r = buildNextRound(db, sid, deck);
    expect(r.done).toBe(false);
    resolveAll(db, sid, [{ pairIndex: 0, aPick: 'thai', bPick: 'sushi' }]);
    r = buildNextRound(db, sid, deck);
    expect(r).toEqual({ done: true, winner: 'thai' });
  });

  it('does not auto-resolve if a non-final-pair round broke the streak', () => {
    const deck = ['a', 'b', 'c'];
    createRound(db, sid, 0, ['a', 'b', 'c']);
    resolveAll(db, sid, [{ pairIndex: 0, aPick: 'a', bPick: 'b' }]);
    let r = buildNextRound(db, sid, deck);
    expect(r.done).toBe(false);
    resolveAll(db, sid, [{ pairIndex: 0, aPick: 'a', bPick: 'b' }]);
    r = buildNextRound(db, sid, deck);
    expect(r.done).toBe(false);
    resolveAll(db, sid, [{ pairIndex: 0, aPick: 'a', bPick: 'b' }]);
    r = buildNextRound(db, sid, deck);
    expect(r.done).toBe(false);
  });
});
