# fooder

Two-person swipe app for picking dinner. Personal hack.

## Local dev

Requires Node 24 (pinned via `.mise.toml`).

    mise install               # installs Node 24 if not present
    npm install
    cp .env.example .env       # fill in GOOGLE_PLACES_API_KEY, HOME_LAT, HOME_LNG
    npm run dev

`npm run dev` loads `.env` via Node's built-in `--env-file` flag.

Open http://localhost:3000/a in one window/tab and /b in another. Two tabs in the same browser work fine — each page bakes its side into the HTML and sends `?side=a|b` on every API call.

Set `SIDE_A_NAME` and `SIDE_B_NAME` in `.env` to use real names. With `SIDE_A_NAME=James`, `/` redirects to `/james` and you open `/sarah` for the other side. When names are set, the bare `/a` and `/b` paths 404 — only the slugs work.

## Favorites

Pre-load go-to restaurants per cuisine so they show first in the restaurant deck. Create `favorites.json` (path configurable via `FAVORITES_FILE`):

    {
      "thai": ["ChIJxxxx..."],
      "middle-eastern": ["ChIJyyyy..."],
      "chinese": ["ChIJzzzz..."]
    }

Each value is a Google Place ID. Grab one by opening the restaurant on Google Maps → Share → look for `place/...` in the URL (or use the [Place ID Finder](https://developers.google.com/maps/documentation/places/web-service/place-id)). Cuisine ids must match the ones in `src/cuisines.js` (e.g. `thai`, `middle-eastern`, `chinese`, `pizza`, ...).

On a cuisine match, favorites for that cuisine appear at the top of the restaurant deck, followed by Google Places search results (deduped). One Google "Place Details" API call per favorite, cached 24h.

See `favorites.example.json`.

## Tests

    npm test

## Deploy (Railway)

1. Push to GitHub.
2. New Railway project from the repo.
3. Add a volume mounted at `/data`.
4. Set env vars: `GOOGLE_PLACES_API_KEY`, `HOME_LAT`, `HOME_LNG`, and optionally `SEARCH_RADIUS_METERS`.
5. Deploy. Railway will run `npm start` automatically.

## Google Places setup

1. In Google Cloud Console, enable the **Places API (New)**.
2. Create an API key, restrict it to that API.
3. Paste it into the `GOOGLE_PLACES_API_KEY` env var.

Pricing: ~$32 / 1000 Text Search calls. The app caches results per cuisine for 24h, so daily use stays well under the $200/month Google free credit.
