function now() {
  return Date.now();
}

export function createSession(db) {
  const t = now();
  const info = db
    .prepare(
      "INSERT INTO session(phase, created_at, updated_at) VALUES (?, ?, ?)",
    )
    .run("cuisines", t, t);
  return getSessionById(db, info.lastInsertRowid);
}

export function getCurrentSession(db) {
  const row = db.prepare("SELECT * FROM session ORDER BY id DESC LIMIT 1").get();
  return row ? rowToSession(row) : null;
}

export function getSessionById(db, id) {
  const row = db.prepare("SELECT * FROM session WHERE id = ?").get(id);
  return row ? rowToSession(row) : null;
}

function rowToSession(r) {
  return {
    id: r.id,
    phase: r.phase,
    matchedCuisine: r.matched_cuisine,
    matchedRestaurantJson: r.matched_restaurant_json,
  };
}

export function recordSwipe(db, { sessionId, side, phase, itemId, direction }) {
  db.prepare(
    "INSERT OR REPLACE INTO swipe(session_id, side, phase, item_id, direction, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(sessionId, side, phase, itemId, direction, now());

  if (direction !== "right") return { matched: false };
  const otherSide = side === "a" ? "b" : "a";
  const other = db
    .prepare(
      "SELECT direction FROM swipe WHERE session_id=? AND side=? AND phase=? AND item_id=?",
    )
    .get(sessionId, otherSide, phase, itemId);
  if (other && other.direction === "right") {
    return { matched: true, itemId };
  }
  return { matched: false };
}

export function getSwipes(db, sessionId, phase) {
  return db
    .prepare(
      "SELECT side, item_id AS itemId, direction FROM swipe WHERE session_id=? AND phase=?",
    )
    .all(sessionId, phase);
}

export function advanceOnMatch(db, { sessionId, phase, match }) {
  const t = now();
  if (phase === "cuisines") {
    db.prepare(
      "UPDATE session SET phase=?, matched_cuisine=?, updated_at=? WHERE id=?",
    ).run("restaurants", match.id, t, sessionId);
  } else if (phase === "restaurants") {
    db.prepare(
      "UPDATE session SET phase=?, matched_restaurant_json=?, updated_at=? WHERE id=?",
    ).run("done", JSON.stringify(match), t, sessionId);
  } else {
    throw new Error(`advanceOnMatch: unexpected phase ${phase}`);
  }
  return getSessionById(db, sessionId);
}

export function isDeckExhausted(db, sessionId, phase, deckIds) {
  const rows = db.prepare(
    "SELECT side, item_id FROM swipe WHERE session_id=? AND phase=?",
  ).all(sessionId, phase);
  const aSwiped = new Set(rows.filter(r => r.side === "a").map(r => r.item_id));
  const bSwiped = new Set(rows.filter(r => r.side === "b").map(r => r.item_id));
  return deckIds.every(id => aSwiped.has(id) && bSwiped.has(id));
}
