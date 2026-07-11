import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/db.js";
import {
  createSession,
  recordSwipe,
  getCurrentSession,
  getSwipes,
  advanceOnMatch,
  isDeckExhausted,
  resetPhase,
  resetSession,
  computeCuisineOverlap,
  setCuisineStage,
  getSessionById,
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
    expect(s.cuisineStage).toBe("swipe");
    expect(s.matchedCuisine).toBeNull();
  });
  it("getCurrentSession returns the most recent session", () => {
    createSession(db);
    const s2 = createSession(db);
    expect(getCurrentSession(db).id).toBe(s2.id);
  });
});

describe("recordSwipe — cuisines phase no longer reports instant match", () => {
  it("returns matched:false even when both sides right-swipe the same cuisine", () => {
    const s = createSession(db);
    recordSwipe(db, { sessionId: s.id, side: "a", phase: "cuisines", itemId: "thai", direction: "right" });
    const result = recordSwipe(db, { sessionId: s.id, side: "b", phase: "cuisines", itemId: "thai", direction: "right" });
    expect(result.matched).toBe(false);
  });
});

describe("recordSwipe — restaurants phase still reports instant match", () => {
  it("returns matched:true when both right-swipe the same restaurant", () => {
    const s = createSession(db);
    recordSwipe(db, { sessionId: s.id, side: "a", phase: "restaurants", itemId: "ChIJ1", direction: "right" });
    const result = recordSwipe(db, { sessionId: s.id, side: "b", phase: "restaurants", itemId: "ChIJ1", direction: "right" });
    expect(result.matched).toBe(true);
    expect(result.itemId).toBe("ChIJ1");
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

describe("resets", () => {
  it("resetPhase clears swipes for the given phase only", () => {
    const s = createSession(db);
    recordSwipe(db, { sessionId: s.id, side: "a", phase: "cuisines", itemId: "thai", direction: "right" });
    recordSwipe(db, { sessionId: s.id, side: "a", phase: "restaurants", itemId: "ChIJ1", direction: "right" });
    resetPhase(db, s.id, "cuisines");
    expect(getSwipes(db, s.id, "cuisines")).toHaveLength(0);
    expect(getSwipes(db, s.id, "restaurants")).toHaveLength(1);
  });
  it("resetSession creates a new session in cuisines phase", () => {
    const s1 = createSession(db);
    advanceOnMatch(db, { sessionId: s1.id, phase: "cuisines", match: { id: "thai", name: "Thai" } });
    const s2 = resetSession(db);
    expect(s2.id).toBeGreaterThan(s1.id);
    expect(s2.phase).toBe("cuisines");
    expect(getCurrentSession(db).id).toBe(s2.id);
  });
});


describe("computeCuisineOverlap", () => {
  const deckIds = ["pizza", "thai", "sushi", "burgers"];
  it("returns deck-ordered intersection of right-swipes from both sides", () => {
    const s = createSession(db);
    recordSwipe(db, { sessionId: s.id, side: "a", phase: "cuisines", itemId: "thai", direction: "right" });
    recordSwipe(db, { sessionId: s.id, side: "a", phase: "cuisines", itemId: "sushi", direction: "right" });
    recordSwipe(db, { sessionId: s.id, side: "b", phase: "cuisines", itemId: "sushi", direction: "right" });
    recordSwipe(db, { sessionId: s.id, side: "b", phase: "cuisines", itemId: "burgers", direction: "right" });
    expect(computeCuisineOverlap(db, s.id, deckIds)).toEqual(["sushi"]);
  });

  it("preserves deck order for multiple overlap items", () => {
    const s = createSession(db);
    for (const id of ["burgers", "pizza", "thai"]) {
      recordSwipe(db, { sessionId: s.id, side: "a", phase: "cuisines", itemId: id, direction: "right" });
      recordSwipe(db, { sessionId: s.id, side: "b", phase: "cuisines", itemId: id, direction: "right" });
    }
    expect(computeCuisineOverlap(db, s.id, deckIds)).toEqual(["pizza", "thai", "burgers"]);
  });
});

describe("setCuisineStage", () => {
  it("updates cuisine_stage and returns the new session", () => {
    const s = createSession(db);
    expect(s.cuisineStage).toBe("swipe");
    const updated = setCuisineStage(db, s.id, "bracket");
    expect(updated.cuisineStage).toBe("bracket");
    expect(getSessionById(db, s.id).cuisineStage).toBe("bracket");
  });
  it("rejects invalid stage values", () => {
    const s = createSession(db);
    expect(() => setCuisineStage(db, s.id, "bogus")).toThrow();
  });
});
