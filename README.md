# fooder

Two-person swipe app for picking dinner. Personal hack.

## Local dev

    npm install
    cp .env.example .env  # fill in GOOGLE_PLACES_API_KEY, HOME_LAT, HOME_LNG
    npm run dev

Open http://localhost:3000/a in one window and /b in another (use a separate browser profile or incognito so cookies don't collide).

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
