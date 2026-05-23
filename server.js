import express from 'express';
import fs from 'node:fs';
import { openDb } from './src/db.js';
import { makePlacesClient } from './src/places.js';
import { createSseHub } from './src/sse.js';
import { makeRouter } from './src/routes.js';

export function validateEnv(env) {
  function required(name) {
    const v = env[name];
    if (v === undefined || v === '') throw new Error(`Missing required env var: ${name}`);
    return v;
  }
  function num(name, value, fallback) {
    if (value === undefined || value === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`Env var ${name} must be a number, got "${value}"`);
    return n;
  }
  const apiKey = required('GOOGLE_PLACES_API_KEY');
  const lat = num('HOME_LAT', required('HOME_LAT'));
  const lng = num('HOME_LNG', required('HOME_LNG'));
  return {
    apiKey,
    home: { lat, lng },
    radiusMeters: num('SEARCH_RADIUS_METERS', env.SEARCH_RADIUS_METERS, 5000),
    port: num('PORT', env.PORT, 3000),
    dbPath: env.DB_PATH ?? '/data/fooder.db',
    sideNames: { a: env.SIDE_A_NAME ?? 'A', b: env.SIDE_B_NAME ?? 'B' },
    favoritesFile: env.FAVORITES_FILE ?? './favorites.json',
    favoritesJson: env.FAVORITES_JSON ?? null,
  };
}

export function loadFavorites({ favoritesJson, favoritesFile }) {
  if (favoritesJson) {
    try {
      const parsed = JSON.parse(favoritesJson);
      if (parsed && typeof parsed === 'object') return parsed;
      console.warn('FAVORITES_JSON is not a JSON object; ignoring');
    } catch (err) {
      console.warn(`FAVORITES_JSON is malformed: ${err.message}`);
    }
  }
  if (!fs.existsSync(favoritesFile)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(favoritesFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch (err) {
    console.warn(`favorites file ${favoritesFile} is malformed: ${err.message}`);
    return {};
  }
}

function buildApp(cfg) {
  const db = openDb(cfg.dbPath);
  const hub = createSseHub();
  const favorites = loadFavorites({ favoritesJson: cfg.favoritesJson, favoritesFile: cfg.favoritesFile });
  const places = makePlacesClient({
    db, fetch, apiKey: cfg.apiKey, home: cfg.home, radiusMeters: cfg.radiusMeters,
    now: Date.now, favorites,
  });
  const app = express();
  app.use(express.json());
  app.use(makeRouter({ db, places, hub, sideNames: cfg.sideNames }));
  return app;
}

// Boot only when run directly, not when imported by tests
if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = validateEnv(process.env);
  const app = buildApp(cfg);
  app.listen(cfg.port, () => {
    console.log(`fooder listening on ${cfg.port}`);
  });
}
