# fooder

Two-person swipe app for picking dinner. Personal hack.

Two phases:

1. **Cuisines** — both partners swipe through a fixed deck (Pizza, Thai, Sushi, ...). First cuisine you both swipe right on wins. The rest of the deck is skipped.
2. **Restaurants** — server fetches restaurants for that cuisine from Google Places, prepends any favorites you've configured, and serves them as a deck. First restaurant you both swipe right on wins. Match screen shows photo, address, phone, Google Maps link.

Real-time over SSE: when one of you swipes right on something the other already liked, both phones jump to the next screen immediately.

## Local dev

Requires Node 24 (pinned via `.mise.toml`).

    mise install               # installs Node 24 if not present
    npm install
    cp .env.example .env       # fill in the required vars (see below)
    npm run dev

`npm run dev` loads `.env` via Node's built-in `--env-file` flag.

Open the app in two tabs — one per side. With default settings, that's http://localhost:3000/a and http://localhost:3000/b. With names set (see below), it's http://localhost:3000/james and http://localhost:3000/sarah. Two tabs in the same browser work — each page bakes its side into the served HTML and includes `?side=a|b` on every API call.

## Tests

    npm test

58 tests across the db, session machine, places client, SSE hub, routes, and a full end-to-end integration. All run in-memory.

## Environment variables

| Var | Required | Default | What it does |
|------|---------|---------|--------------|
| `GOOGLE_PLACES_API_KEY` | yes | — | Google Cloud API key with Places API (New) enabled |
| `HOME_LAT` | yes | — | Latitude of the location bias circle for restaurant search |
| `HOME_LNG` | yes | — | Longitude |
| `SEARCH_RADIUS_METERS` | no | `5000` | Radius (m) of the location bias |
| `SIDE_A_NAME` | no | `A` | Display name for side A (e.g. `James`). Becomes the URL slug. |
| `SIDE_B_NAME` | no | `B` | Display name for side B (e.g. `Sarah`). |
| `FAVORITES_FILE` | no | `./favorites.json` | Path to favorites JSON (see Favorites) |
| `DB_PATH` | no | `/data/fooder.db` | SQLite database path. Locally, override to `./fooder.db`. |
| `PORT` | no | `3000` | HTTP port. Railway sets this automatically. |

### Side names and URLs

`SIDE_A_NAME` and `SIDE_B_NAME` control both the status-bar display and the URL paths:

- Defaults `A` / `B` → routes are `/a` and `/b`, status bar shows `A` / `B`.
- Set `SIDE_A_NAME=James`, `SIDE_B_NAME=Sarah` → routes are `/james` / `/sarah`, status bar shows the names. **The bare `/a` and `/b` paths return 404** in this configuration — only the slugged names work.

Names get slugified: lowercased, non-alphanumerics replaced with `-`. So `SIDE_A_NAME="Mary Jane"` becomes `/mary-jane`. If both names slugify to the same value, the server fails fast at boot.

`/` redirects to side A's slug, so opening just `http://localhost:3000/` lands on `/james` (or `/a` with defaults).

## Favorites

Pre-load go-to restaurants per cuisine so they appear first in the restaurant deck. Create `favorites.json` at the repo root (or wherever `FAVORITES_FILE` points):

    {
      "thai": ["ChIJxxxx..."],
      "middle-eastern": ["ChIJyyyy..."],
      "chinese": ["ChIJzzzz..."]
    }

Each value is a Google Place ID. Get one from the [Place ID Finder](https://developers.google.com/maps/documentation/places/web-service/place-id). Cuisine ids must match those in `src/cuisines.js` (`pizza`, `thai`, `sushi`, `burgers`, `mexican`, `indian`, `chinese`, `middle-eastern`, `korean`, `vietnamese`, `ramen`, `italian`, `bbq`, `sandwiches`, `salad`).

On a cuisine match, favorites for that cuisine are fetched (one Google "Place Details" call per favorite, cached 24h) and prepended to the deck before the Google Places search results. Duplicates are filtered out by Place ID.

If the favorites file is missing or malformed, the app boots normally with no favorites and only uses search results. See `favorites.example.json` for the format.

## Google Places setup

1. In Google Cloud Console, enable the **Places API (New)**.
2. Create an API key, restrict it to that API.
3. Paste it into `GOOGLE_PLACES_API_KEY`.

Pricing: ~$32 per 1000 Text Search calls, ~$17 per 1000 Place Details calls. Both responses cache 24h, so realistic personal use stays inside Google's $200/month free credit by a wide margin.

## Deploy (Railway)

1. Push to GitHub.
2. New Railway project from the repo. Nixpacks reads `engines` in `package.json` and provisions Node 24.
3. Add a volume mounted at `/data` (so the SQLite db survives deploys).
4. Set env vars in Railway's UI — at minimum `GOOGLE_PLACES_API_KEY`, `HOME_LAT`, `HOME_LNG`. Add `SIDE_A_NAME` / `SIDE_B_NAME` if you want named URLs.
5. For favorites: commit `favorites.json` to the repo, or copy it to the `/data` volume and set `FAVORITES_FILE=/data/favorites.json`.
6. `npm start` is wired in `railway.toml`; deploy.

## Architecture (one-liner per file)

- `server.js` — entry: env validation, app composition, listen
- `src/db.js` — SQLite schema (sessions, swipes, restaurant cache, place cache)
- `src/cuisines.js` — hardcoded cuisine deck
- `src/session.js` — session/swipe state machine: match detection, phase transitions, resets
- `src/places.js` — Google Places client: searchText, place details, photo proxy, 24h caches
- `src/sse.js` — connection hub: register/unregister, broadcast, online tracking
- `src/routes.js` — Express routes for `/api/*`, slugged side serving, photo proxy
- `public/` — vanilla HTML/CSS/JS frontend, no build step
