import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/db.js";
import {
  createSession,
  recordSwipe,
  getCurrentSession,
  getSwipes,
  advanceOnMatch,
  isDeckExhausted,
} from "../src/session.js";

let db;
beforeEach(() => {
  db = openDb(":memory:");
});

describe("session creation", () => {
  it("createSession returns a new session in cuisines phase", () => {
    const s = createSession(db);
    expect(s.id).toBeGreaterThan(0);
    expect(s.phase).toBe("cuisines");
    expect(s.matchedCuisine).toBeNull();
  });
  it("getCurrentSession returns the most recent session", () => {
    createSession(db);
    const s2 = createSession(db);
    expect(getCurrentSession(db).id).toBe(s2.id);
  });
});

describe("recordSwipe + match detection (cuisines)", () => {
  it("returns matched:false on a single side swipe", () => {
    const s = createSession(db);
    const result = recordSwipe(db, {
      sessionId: s.id,
      side: "a",
      phase: "cuisines",
      itemId: "thai",
      direction: "right",
    });
    expect(result.matched).toBe(false);
  });
  it("returns matched:true when both sides swipe right on the same item", () => {
    const s = createSession(db);
    recordSwipe(db, {
      sessionId: s.id,
      side: "a",
      phase: "cuisines",
      itemId: "thai",
      direction: "right",
    });
    const result = recordSwipe(db, {
      sessionId: s.id,
      side: "b",
      phase: "cuisines",
      itemId: "thai",
      direction: "right",
    });
    expect(result.matched).toBe(true);
    expect(result.itemId).toBe("thai");
  });
  it("no match when one side swipes left", () => {
    const s = createSession(db);
    recordSwipe(db, {
      sessionId: s.id,
      side: "a",
      phase: "cuisines",
      itemId: "thai",
      direction: "right",
    });
    const result = recordSwipe(db, {
      sessionId: s.id,
      side: "b",
      phase: "cuisines",
      itemId: "thai",
      direction: "left",
    });
    expect(result.matched).toBe(false);
  });
  it("idempotent: repeated swipe is a no-op for match detection", () => {
    const s = createSession(db);
    recordSwipe(db, {
      sessionId: s.id,
      side: "a",
      phase: "cuisines",
      itemId: "thai",
      direction: "right",
    });
    recordSwipe(db, {
      sessionId: s.id,
      side: "a",
      phase: "cuisines",
      itemId: "thai",
      direction: "right",
    });
    expect(getSwipes(db, s.id, "cuisines").length).toBe(1);
  });
});

describe("phase transitions", () => {
  it("cuisine match advances to restaurants phase", () => {
    const s = createSession(db);
    const after = advanceOnMatch(db, { sessionId: s.id, phase: "cuisines", match: { id: "thai", name: "Thai" } });
    expect(after.phase).toBe("restaurants");
    expect(after.matchedCuisine).toBe("thai");
  });
  it("restaurant match advances to done with stored payload", () => {
    const s = createSession(db);
    advanceOnMatch(db, { sessionId: s.id, phase: "cuisines", match: { id: "thai", name: "Thai" } });
    const restaurant = { id: "ChIJ1", name: "Spicy Thai", address: "...", phone: null, mapsUrl: "...", rating: 4.5, priceLevel: 2, photoUrl: null };
    const after = advanceOnMatch(db, { sessionId: s.id, phase: "restaurants", match: restaurant });
    expect(after.phase).toBe("done");
    expect(JSON.parse(after.matchedRestaurantJson).name).toBe("Spicy Thai");
  });
});

describe("isDeckExhausted", () => {
  const deckIds = ["pizza", "thai", "sushi"];
  it("false when no swipes yet", () => {
    const s = createSession(db);
    expect(isDeckExhausted(db, s.id, "cuisines", deckIds)).toBe(false);
  });
  it("false when only one side has finished", () => {
    const s = createSession(db);
    for (const id of deckIds) recordSwipe(db, { sessionId: s.id, side: "a", phase: "cuisines", itemId: id, direction: "left" });
    expect(isDeckExhausted(db, s.id, "cuisines", deckIds)).toBe(false);
  });
  it("true when both sides have swiped every item with no mutual right", () => {
    const s = createSession(db);
    for (const id of deckIds) {
      recordSwipe(db, { sessionId: s.id, side: "a", phase: "cuisines", itemId: id, direction: "left" });
      recordSwipe(db, { sessionId: s.id, side: "b", phase: "cuisines", itemId: id, direction: "right" });
    }
    expect(isDeckExhausted(db, s.id, "cuisines", deckIds)).toBe(true);
  });
});
