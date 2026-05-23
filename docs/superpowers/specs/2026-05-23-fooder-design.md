# Fooder — design spec

A two-person, two-phase swipe app for "what should we eat?" One partner and I swipe on cuisines until we both like the same one, then swipe on real restaurants of that cuisine until we both like the same one. First match in each phase wins.

Personal hack. Deployed on Railway. No accounts, no general-user support.

## Goals

- Decide on dinner in under two minutes of swiping.
- Both partners using their own phone, possibly not in the same room.
- "We matched!" feels instant — the second person swiping right on a thing the other already liked sees a match screen immediately, and so does the first person.
- One running instance for two people. No multi-tenancy.

## Non-goals

- In-app ordering. The match screen links out to Google Maps and a `tel:` link.
- Login, accounts, profiles, history beyond the current session.
- Friend graph, multiple pairings, sharing with others.
- Native apps.
- Working when offline.

## Architecture

```
Browser (/a)             Browser (/b)
   │                        │
   └────── HTTPS / SSE ─────┘
                │
         Express on Railway
         ├── GET  /             → redirect to /a or /b based on cookie, else /a
         ├── GET  /:side        → serves index.html (side ∈ {a, b})
         ├── GET  /api/state    → { phase, deck, mySwipes, partnerOnline }
         ├── POST /api/swipe    → { itemId, direction }
         ├── POST /api/reset    → { scope: "phase" | "session" } (phase = clear current phase's swipes; session = new session from phase 1)
         ├── GET  /api/events   → SSE: match, phase-change, session-reset, phase-reset
         ├── GET  /api/photo/:name → proxies Google Place Photo (hides API key)
         └── better-sqlite3     → /data/fooder.db (Railway volume)
                │
         Google Places API (New) — `places:searchText` (per-cuisine cache, 24h TTL)
```

**Stack:** Node 22, Express, better-sqlite3, vanilla HTML/CSS/JS frontend (no build step). Single `npm start` entrypoint.

**Why no framework:** a handful of screens, one fancy interaction (swipe card). Pointer events + CSS transforms handle swiping. A build step would be more code than the framework saves.

## Side identification

URL path is identity. `/a` is one partner, `/b` is the other. A cookie remembers which side a given browser is on so opening the bare root sends you back to your side.

There is no enforcement that the same person stays on the same side — this is a personal hack and the worst case is the two phones see each other's swipes from one session, which doesn't matter because they're both choosing dinner together.

## The two phases

### Phase 1 — Cuisines

- Hardcoded deck of ~15 cuisines (e.g., Pizza, Thai, Sushi, Burgers, Mexican, Indian, Chinese, Mediterranean, Korean, Vietnamese, Ramen, Italian, BBQ, Sandwiches, Salad).
- Same order for both partners.
- Each swipe right is recorded server-side. Each swipe left is also recorded (so we know when a partner has exhausted their deck).
- The moment the server sees both sides have swiped right on the same cuisine, it sets `matched_cuisine` and emits a `match` SSE event to both clients. On receiving `match`, each client immediately switches to the match screen — even mid-swipe on a later card. Any in-flight swipe POSTs are accepted but become irrelevant.

### Phase 2 — Restaurants

- Triggered automatically by the cuisine match.
- Server POSTs to Google Places API (New) `https://places.googleapis.com/v1/places:searchText` with body `{ textQuery: "<cuisine> restaurants", locationBias: { circle: { center: { latitude: $HOME_LAT, longitude: $HOME_LNG }, radius: $SEARCH_RADIUS_METERS } }, maxResultCount: 10, openNow: true }` and a `X-Goog-FieldMask` header restricting fields to `places.id,places.displayName,places.formattedAddress,places.rating,places.priceLevel,places.nationalPhoneNumber,places.googleMapsUri,places.photos`.
- Result is cached for 24h keyed on `(cuisine, "$HOME_LAT,$HOME_LNG")`.
- Both partners swipe through the same ten restaurants in the order Google returned them.
- First mutual right-swipe → `matched_restaurant_json` set → `match` event with restaurant payload (name, address, phone, Google Maps URL, rating, priceLevel, photo proxy URL) → restaurants match screen.

## Match screen

- Big restaurant name, photo (if Google returned one — fetched via the photo proxy endpoint), rating, price tier rendered as `$` × `priceLevel` (0–4).
- Address (tappable → opens the `googleMapsUri` so the OS picks the right maps app).
- Phone (tappable → `tel:` link).
- "View on Google Maps" button (same `googleMapsUri`).
- "Start over" button → POSTs `/api/reset` with `{ scope: "session" }` → both clients receive `session-reset` SSE → both go back to phase 1 with cleared state.

## Edge cases

- **Deck exhausted with no match.** Show "No overlap on cuisines (or restaurants) — try again?" with a reset button. The button POSTs `/api/reset` with `{ scope: "phase" }`, which clears just the current phase's swipes (keeping the matched cuisine if in phase 2) and emits `phase-reset` so both clients reshuffle and re-enter the deck.
- **Partner not online yet.** Your right-swipes queue server-side. The match check runs on every swipe, so the match fires the moment the second person catches up.
- **Google Places API failure.** Show the cached payload if any. If no cache, show "Google Places is down — eat {cuisine} somewhere, sort it out yourselves" with a reset button.
- **No Google results for cuisine + location.** Show "no restaurants found for {cuisine}, pick something else?" with a button that triggers a `session` reset, sending both clients back to phase 1.
- **SSE disconnect.** Browser auto-reconnects (native EventSource behavior). On reconnect, client refetches `/api/state` to catch up on any matches that fired while disconnected.
- **Both partners hit reset simultaneously.** Last write wins. Both clients get the `session-reset` event regardless and end up in the same state.

## Data model

```sql
CREATE TABLE session (
  id INTEGER PRIMARY KEY,
  phase TEXT NOT NULL CHECK (phase IN ('cuisines', 'restaurants', 'done')),
  matched_cuisine TEXT,
  matched_restaurant_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE swipe (
  session_id INTEGER NOT NULL REFERENCES session(id),
  side TEXT NOT NULL CHECK (side IN ('a', 'b')),
  phase TEXT NOT NULL,
  item_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('left', 'right')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, side, phase, item_id)
);

CREATE TABLE restaurant_cache (
  cuisine TEXT NOT NULL,
  location TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (cuisine, location)
);
```

One active session at a time. The "current" session is the most recent row in `session`. Old sessions are kept (small data, fine for nostalgia / debugging).

`PRIMARY KEY (session_id, side, phase, item_id)` makes swipes idempotent — a double-tap or replayed request can't double-count.

## SSE event shapes

```json
{ "type": "match", "phase": "cuisines", "item": { "id": "thai", "name": "Thai" } }
{ "type": "match", "phase": "restaurants", "item": { "id": "ChIJ...", "name": "Spicy Thai", "address": "...", "phone": "...", "mapsUrl": "https://maps.google.com/?cid=...", "rating": 4.5, "priceLevel": 2, "photoUrl": "/api/photo/places/ChIJ.../photos/AbCdEf..." } }
{ "type": "phase-change", "phase": "restaurants", "deck": [ ... ten restaurants ... ] }
{ "type": "phase-reset", "phase": "cuisines" | "restaurants", "deck": [ ... ] }
{ "type": "session-reset" }
{ "type": "partner-online", "side": "a" | "b", "online": true | false }
```

`phase-change` carries the new deck so the client doesn't need a separate fetch. `partner-online` is informational (small "your partner is here" indicator), based on whether an SSE connection from the other side is currently open.

## Config (env)

| var | meaning | required |
|------|---------|----------|
| `GOOGLE_PLACES_API_KEY` | Google Cloud API key with Places API (New) enabled | yes |
| `HOME_LAT` | Latitude for the location bias circle | yes |
| `HOME_LNG` | Longitude for the location bias circle | yes |
| `SEARCH_RADIUS_METERS` | Radius of the location bias circle | no, default `5000` |
| `PORT` | HTTP port | no, Railway sets it |
| `DB_PATH` | SQLite file path | no, default `/data/fooder.db` |

Server fails fast at boot if required vars are missing, with a clear message naming the missing var.

## Frontend structure

Single `index.html` + `app.js` + `app.css`. The frontend has three views, switched by JS (no router):

1. `cuisines-deck` — stack of cuisine cards, swipe handlers, swipe counter ("3 / 15").
2. `restaurants-deck` — same as above but with restaurant cards (photo, name, rating, distance).
3. `match-screen` — final result, address/phone/Google Maps link, reset button.

A small "phase: cuisines · partner: online" status bar at the top.

Swipe interaction: pointer events (`pointerdown`, `pointermove`, `pointerup`) drive a CSS transform on the top card. Past a threshold horizontal distance, the card flies off in that direction and POSTs the swipe.

## Testing

- **Backend unit tests** (`vitest`): swipe matching logic given a sequence of swipes from both sides; cache TTL; phase-transition state machine.
- **Backend integration tests**: spin up the Express app with an in-memory SQLite and a fake Places client. Cover the full flow: both connect, swipe to match in phase 1, get the phase-change event, swipe to match in phase 2, get the restaurant match.
- **No frontend automated tests** for this hack. Smoke-test manually in two browser windows before declaring done.

## Deployment

- `package.json` `start` script: `node server.js`.
- Railway: Node service, mount a volume at `/data`, set env vars listed above.
- No build step. Push to deploy.

## Out of scope (explicitly)

- Persistent user accounts.
- Match history page.
- Friend pairing / group ordering.
- Real-time chat between partners.
- Filter UI for price, distance, rating, dietary preferences (food categories beyond the hardcoded list).
- Notifications when partner is online and there's a stale match waiting.
- iOS/Android wrappers.
