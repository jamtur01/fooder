import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/db.js";
import {
  createSession,
  recordSwipe,
  getCurrentSession,
  getSwipes,
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
