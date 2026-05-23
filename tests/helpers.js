import express from 'express';
import { openDb } from '../src/db.js';
import { createSseHub } from '../src/sse.js';
import { makeRouter } from '../src/routes.js';

export function buildApp({ placesOverride } = {}) {
  const db = openDb(':memory:');
  const hub = createSseHub();
  const places = placesOverride ?? {
    searchRestaurants: async () => [],
    fetchPhoto: async () => ({ body: new ArrayBuffer(0), contentType: 'image/jpeg' }),
  };
  const app = express();
  app.use(express.json());
  app.use(makeRouter({ db, places, hub }));
  return { app, db, hub, places };
}
