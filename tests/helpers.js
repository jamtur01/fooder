import express from 'express';
import http from 'node:http';
import request from 'supertest';
import { openDb } from '../src/db.js';
import { createSseHub } from '../src/sse.js';
import { makeRouter } from '../src/routes.js';

export function buildApp({ placesOverride, sideNames } = {}) {
  const db = openDb(':memory:');
  const hub = createSseHub();
  const places = placesOverride ?? {
    searchRestaurants: async () => [],
    fetchPhoto: async () => ({ body: new ArrayBuffer(0), contentType: 'image/jpeg' }),
    fetchPlace: async () => ({ id: 'x', name: 'x', address: '', phone: null, mapsUrl: null, rating: null, priceLevel: null, photoUrl: null }),
    getFavorites: async () => [],
  };
  const app = express();
  app.use(express.json());
  app.use(makeRouter({ db, places, hub, sideNames }));
  // One listening server per app: supertest reuses a server it didn't start,
  // while per-request ephemeral servers caused sporadic ECONNRESET, hangs,
  // and dropped writes under the suite's connection churn.
  const server = http.createServer(app);
  server.listen(0);
  server.unref();
  return { app, db, hub, places, agent: request.agent(server) };
}
