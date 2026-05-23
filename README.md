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

Set `SIDE_A_NAME` and `SIDE_B_NAME` in `.env` to use real names. With `SIDE_A_NAME=James`, `/` redirects to `/james` and you can open `/sarah` for the other side. `/a` and `/b` still work as canonical aliases.

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
