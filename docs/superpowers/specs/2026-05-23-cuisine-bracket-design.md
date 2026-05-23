# Cuisine bracket — design spec

Change the cuisine-matching mechanic from "first mutual right-swipe ends phase 1" to a two-stage flow: both partners blind-swipe through the whole cuisine deck, then run a tap-based bracket over the overlap set. The restaurant phase is unchanged (still instant match).

This addresses the complaint that instant matching biases toward whichever cuisine happens to appear early in the deck and skips the discussion about *which* shared preference is the best one.

## Goals

- Both partners see and rate every cuisine before any choice is locked in.
- The final cuisine pick reflects relative preference, not deck order.
- Stubborn disagreements don't infinite-loop.
- Bracket-related state respects the existing phase/session reset semantics.

## Non-goals

- Changing the restaurants phase. Still first-mutual-right-swipe wins.
- Cross-phase brackets, bracket-of-restaurants, scored swipes, super-likes.
- History or analytics ("here are all the brackets you've ever played").

## Stage breakdown

Phase 1 (`cuisines`) is split into two internal stages stored on the session row.

### Stage 1a — solo swipe

Both partners swipe through every cuisine card independently. Identical to today's swipe UI but:

- No instant match. The server records swipes but does not emit a `match` event when both right-swipe on the same item.
- "Finished" means the side has recorded a swipe (left or right) for every item in the cuisine deck. When one partner finishes, the other sees an indicator: `partner is done — your turn (n/total swiped)`.
- When *both* have finished, the server computes the overlap and transitions to stage 1b.

### Stage 1b — bracket

Server computes the overlap set: cuisines both partners right-swiped. Three branches:

- **0 overlap.** Show `no overlap — try again?` with a button that does a phase reset (clears stage 1a swipes only) so both partners re-enter the solo deck.
- **1 overlap.** Skip the bracket. That cuisine wins. Advance to the restaurants phase exactly as today.
- **2+ overlap.** Enter the bracket.

### Bracket mechanics (stage 1b with 2+ overlap)

**Pairing.** Items pair up in original deck order: positions 0&1, 2&3, 4&5, ... If the count is odd, the last item gets a bye and auto-advances to the next round.

**One round.** Both partners see the same pairing as two side-by-side cards (left card = first item, right card = second). Tap to choose. Each tap POSTs the vote. When both partners have voted on the same pairing:

- Both picked the same item → the other is eliminated.
- Picked different items (tie) → both advance.

When the round's last pairing resolves, the server takes the survivors in the order they appeared in the previous round (a pair contributes its winner if eliminated, or both items in their original order if tied), pairs them up sequentially, and starts the next round. Example: a round with pairs `[(thai, sushi), (pizza, ramen), (italian, mexican)]` resolving to `[thai eliminated sushi → sushi]`, `[pizza vs ramen tied → both advance]`, `[italian eliminated mexican → italian]` produces survivor list `[sushi, pizza, ramen, italian]`, paired next round as `[(sushi, pizza), (ramen, italian)]`.

**Loop break.** If after a round the survivors count is unchanged AND only 2 items remain, that's a stalemate on the final pair. After 3 consecutive ties on the same final pair, the item that appeared first in the cuisine deck wins. (This guarantees termination without making "tie" the default arbitrary tiebreaker.)

**Bracket ends** when only 1 item remains. That cuisine becomes `matched_cuisine`, the session advances to the restaurants phase.

## State machine

```
phase='cuisines', stage='swipe'   ← stage 1a
   │
   │ both done swiping
   ▼
phase='cuisines', stage='bracket' ← stage 1b (when overlap >= 2)
   │
   │ bracket resolved
   ▼
phase='restaurants'                ← unchanged
   │
   │ instant match
   ▼
phase='done'
```

When overlap is 0 or 1, stage 1b is effectively bypassed:

- **0 overlap.** `cuisine_stage` stays `'swipe'`. Server emits a `stage-change` event with `stage: 'no-overlap'` (informational, not a real stage). Clients render `view-no-overlap`. A phase reset returns to a normal stage 1a.
- **1 overlap.** Server sets `phase='restaurants'` and `matched_cuisine` directly, without touching `cuisine_stage` (it stays at `'swipe'`, which is harmless because the phase is no longer `'cuisines'`). Emits `phase-change` with the restaurant deck as today.

`cuisine_stage='bracket'` is set only when overlap ≥ 2.

## Reset semantics

Two existing scopes, with internal-stage awareness:

- **`scope: phase` during stage 1a** → delete cuisine swipes for this session; both clients re-enter stage 1a deck.
- **`scope: phase` during stage 1b** → delete bracket votes only (keep cuisine swipes). Both clients re-enter stage 1b from round 1 with the same overlap set.
- **`scope: phase` during restaurants** → unchanged (delete restaurant swipes).
- **`scope: session`** → unchanged. New session row, back to stage 1a.

## Data model

Two new tables, plus a column on `session`.

```sql
ALTER TABLE session ADD COLUMN cuisine_stage TEXT
  CHECK (cuisine_stage IN ('swipe', 'bracket')) NOT NULL DEFAULT 'swipe';

CREATE TABLE IF NOT EXISTS bracket_round (
  session_id INTEGER NOT NULL REFERENCES session(id),
  round_index INTEGER NOT NULL,
  pair_index INTEGER NOT NULL,
  item_a TEXT NOT NULL,
  item_b TEXT NOT NULL,
  outcome TEXT CHECK (outcome IN ('a_wins', 'b_wins', 'both', 'pending')) NOT NULL DEFAULT 'pending',
  PRIMARY KEY (session_id, round_index, pair_index)
);
-- outcome values:
--   'pending' — at least one side hasn't voted
--   'a_wins'  — both sides picked item_a; item_b is eliminated
--   'b_wins'  — both sides picked item_b; item_a is eliminated
--   'both'    — sides picked differently; both items advance to the next round

CREATE TABLE IF NOT EXISTS bracket_vote (
  session_id INTEGER NOT NULL REFERENCES session(id),
  round_index INTEGER NOT NULL,
  pair_index INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('a', 'b')),
  pick TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, round_index, pair_index, side)
);
```

`bracket_round` is the persistent ordering for each round; `bracket_vote` records each side's pick. Outcome on `bracket_round` is computed when both votes are in.

`session.cuisine_stage` is migrated forward for existing sessions: existing rows default to `swipe`.

The existing `swipe` table is unchanged. Cuisine swipes during stage 1a use it exactly as today.

## API changes

### `GET /api/state` — extended response

Adds two fields when in `phase='cuisines'`:

```json
{
  "phase": "cuisines",
  "stage": "swipe" | "bracket",
  "deck": [...],
  "mySwipes": [...],
  "partnerOnline": true,
  "partnerDone": false,
  "bracket": {
    "roundIndex": 0,
    "totalRoundsHint": 3,
    "currentPair": { "pairIndex": 0, "a": <Cuisine>, "b": <Cuisine> } | null,
    "myVote": "thai" | null
  } | null
}
```

`bracket` is `null` during stage 1a. During stage 1b, `currentPair` is the next unresolved pair; `null` means the bracket is finished (server should already have advanced phase). `totalRoundsHint` is `ceil(log2(survivorsAtRoundStart))` — informational only, may overcount when ties persist.

### `POST /api/swipe` — stage-aware

Only valid during stage 1a (or restaurants phase). Returns `400` if called during stage 1b.

Server no longer triggers `match` SSE events from cuisine swipes — it only records.

When a swipe completes the side's last cuisine swipe (i.e. they now have a swipe recorded for every item in `CUISINES`), server:
- emits `partner-done` to the other side (with the swiper's side and final count)
- if both sides have now finished, computes overlap and runs the stage-transition logic (see below)

### `POST /api/bracket-vote` — new endpoint

```json
POST /api/bracket-vote?side=a
{ "pairIndex": 0, "pick": "thai" }
```

Valid only during stage 1b. The pick must match `bracket_round.item_a` or `item_b` for the current round and given `pair_index`. Idempotent — a re-vote overwrites the previous.

When both sides have voted on the same pair, server resolves it, emits `bracket-pair-resolved`. When the last pending pair in the round resolves, server builds the next round and emits `bracket-round-start` with the new pairings.

### `POST /api/reset` — same shape, phase-aware behavior

Already takes `{ scope: 'phase' | 'session' }`. Stage-aware behavior inside:

- `phase` reset during stage 1a → as today.
- `phase` reset during stage 1b → delete from `bracket_round` + `bracket_vote` for this session; emit `phase-reset` with the bracket rebuilt fresh from the existing overlap.
- `session` reset → as today.

## SSE event additions

```json
{ "type": "partner-done", "side": "a" | "b", "swipedCount": 15 }
{ "type": "stage-change", "stage": "bracket", "bracket": { roundIndex, currentPair, totalRoundsHint } }
{ "type": "stage-change", "stage": "no-overlap" }
{ "type": "bracket-pair-resolved", "pairIndex": 0, "outcome": "a_wins" | "b_wins" | "both", "winner": "thai" | null }
{ "type": "bracket-round-start", "roundIndex": 1, "currentPair": { ... } }
{ "type": "bracket-vote-cast", "side": "a", "pairIndex": 0 }   // partner-feedback only; doesn't reveal the pick
```

Existing events (`match`, `phase-change` to restaurants, `phase-reset`, `session-reset`, `partner-online`) are unchanged.

The cuisines-phase `match` event is gone — the bracket-resolution path is what advances to restaurants.

`bracket-vote-cast` is informational only (don't reveal partner's pick) so the waiting partner sees "your partner voted — make your pick" without spoilers.

## Frontend

### New views

- `view-cuisines-waiting` — shown after a side finishes swiping but before the other does. Big "waiting for {partner} (n/15 swiped)" message. A `Start over` button.
- `view-bracket` — shown during stage 1b. Two cards side-by-side (or stacked on phones), tap to vote. Status text indicates round + remaining items. After tapping, the card animates to indicate the vote (e.g. dims the unchosen, scales the chosen). Then a `waiting for {partner}` overlay until SSE confirms.
- `view-no-overlap` — shown when overlap is 0. Header "no overlap" + `Try again` (phase reset) + `Start over` (session reset).

### Existing views

- `view-cuisines` (deck) renamed conceptually to `view-cuisines-swipe`. Unchanged otherwise.
- `view-restaurants` — unchanged.
- `view-match` — unchanged.
- `view-empty` — repurposed only for the deck-exhausted restaurants case. The "no overlap on cuisines" case uses the new `view-no-overlap`.

### Bracket card layout

On wide viewports: two cards side-by-side, separated by a small "VS" divider. Each card is the existing cuisine card style (emoji + name).

On narrow viewports (< 600px): two cards stacked vertically with the divider between them.

Tapping either card POSTs the vote, dims the other card, and shows a waiting indicator. SSE `bracket-pair-resolved` triggers the next state.

## Edge cases

- **Partner disconnects mid-bracket.** Same model as today: SSE auto-reconnects; on reconnect the client refetches `/api/state`. Bracket state is fully recoverable from `bracket_round` + `bracket_vote`.
- **Both partners vote simultaneously on different pairs (shouldn't happen — only one current pair).** The endpoint always validates against the *current* pending pair index from the server's view. Stale votes (wrong `pairIndex`) return `409`.
- **Partner re-votes after both have voted.** Reject with `409`; the round has already resolved.
- **Loop on final pair.** After 3 consecutive ties (tracked server-side via consecutive `outcome='both'` on the same item-pair), the item that appears earliest in the original cuisine deck wins. Server logs the auto-resolution.
- **Bracket with 1 item after a round of all-ties.** Shouldn't happen (a tie means both advance), but defensive: if survivors drop to 1, bracket ends with that item.
- **No-overlap recovery in stage 1a.** If both partners finished swiping and intersect is empty, server emits `stage-change` with `stage: 'no-overlap'`. The frontend uses this rather than continuing to "stage": 'bracket'.

## Testing

- **Unit (session module).** `recordSwipe` no longer emits cuisine matches. New: `bothDoneSwipingCuisines(sessionId)`, `computeCuisineOverlap(sessionId, deckIds)`, `buildBracketRound(survivors)`, `recordBracketVote(...)`, `resolvePair(...)`, `nextRound(survivors)`, plus the loop-break helper.
- **Unit (state machine flow).** Sequence: A swipes 15, B swipes 15 with 3 overlaps → bracket has 2 pairs (one bye) → vote sequences produce expected winner including a tie path.
- **Integration.** Two HTTP clients walk: swipe all cuisines → bracket-vote a few rounds → land in restaurants phase → instant restaurant match. Plus the no-overlap and 1-overlap branches.
- **Manual.** Smoke-test the wait-screen, vs layout, and tie animations on a desktop browser.

## Migration / compat

- The `session` table gains a column; existing rows default to `swipe`. Existing sessions in flight when the deploy happens will lose their place — acceptable, this is a personal hack with at most one in-flight session.
- The cuisine-phase `match` SSE event is removed. Any old client tab connected at deploy time will miss the cuisine match; refreshing fixes it. Same compromise.
- No external API users; no version bump needed.

## Out of scope

- Bracket for restaurants.
- Configurable swipe-then-bracket threshold (e.g. "swipe at least 5 right before bracket").
- Visible partner pick during tie-break (i.e. revealing "they picked Thai") — keeps the negotiation moment for in-person discussion.
- Animation between bracket rounds.
