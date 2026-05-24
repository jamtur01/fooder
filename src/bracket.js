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

function now() { return Date.now(); }

export function createRound(db, sessionId, roundIndex, items) {
  const pairs = pairItemsForRound(items);
  const insert = db.prepare(
    'INSERT INTO bracket_round(session_id, round_index, pair_index, item_a, item_b, outcome) VALUES (?,?,?,?,?,?)'
  );
  const insertMany = db.transaction((rows) => {
    for (const p of rows) {
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

function survivorsFromRound(rows) {
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
  const rounds = db.prepare(
    'SELECT round_index, pair_index, item_a, item_b, outcome FROM bracket_round WHERE session_id=? ORDER BY round_index DESC'
  ).all(sessionId);
  const byRound = new Map();
  for (const r of rounds) {
    if (!byRound.has(r.round_index)) byRound.set(r.round_index, []);
    byRound.get(r.round_index).push(r);
  }
  const sortedRoundIndexes = Array.from(byRound.keys()).sort((x, y) => y - x);
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

  if (survivors.length === 0) throw new Error('buildNextRound: no survivors');
  if (survivors.length === 1) return { done: true, winner: survivors[0] };

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
    'SELECT side, pick FROM bracket_vote WHERE session_id=? AND round_index=? AND pair_index=?'
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
