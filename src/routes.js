import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseCookie, serialize as serializeCookie } from 'cookie';
import { CUISINES } from './cuisines.js';
import {
  createSession,
  getCurrentSession,
  getSwipes,
  recordSwipe,
  advanceOnMatch,
  resetPhase,
  resetSession,
} from './session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');
const INDEX_PATH = path.join(PUBLIC_DIR, 'index.html');

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

function renderIndex(side, sideNames) {
  const html = fs.readFileSync(INDEX_PATH, 'utf8');
  const inject = `<script>window.MY_SIDE=${JSON.stringify(side)};window.SIDE_NAMES=${JSON.stringify(sideNames)};</script>`;
  return html.replace('<!--SIDE-->', inject);
}

function sideOf(req) {
  if (req.query?.side === 'a' || req.query?.side === 'b') return req.query.side;
  const cookies = parseCookie(req.headers.cookie ?? '');
  return cookies.side;
}

function requireSide(req, res, next) {
  const side = sideOf(req);
  if (side !== 'a' && side !== 'b') {
    return res.status(400).json({ error: 'side required (?side=a|b or cookie)' });
  }
  req.side = side;
  next();
}

function ensureSession(db) {
  const s = getCurrentSession(db);
  if (s) return s;
  return createSession(db);
}

async function restaurantsForCuisine(places, cuisine) {
  const [favorites, search] = await Promise.all([
    places.getFavorites(cuisine).catch(() => []),
    places.searchRestaurants(cuisine).catch(() => []),
  ]);
  const seen = new Set(favorites.map(r => r.id));
  return [...favorites, ...search.filter(r => !seen.has(r.id))];
}

async function buildDeck(places, session) {
  if (session.phase === 'cuisines') return CUISINES;
  if (session.phase === 'restaurants') {
    return restaurantsForCuisine(places, session.matchedCuisine);
  }
  return [];
}

function cuisineById(id) { return CUISINES.find(c => c.id === id); }

export function makeRouter({ db, places, hub, sideNames = { a: 'A', b: 'B' } }) {
  const router = express.Router();

  const slugs = { a: slugify(sideNames.a), b: slugify(sideNames.b) };
  if (slugs.a === slugs.b) {
    throw new Error(`SIDE_A_NAME and SIDE_B_NAME slugify to the same value (${slugs.a})`);
  }
  const sideBySlug = {
    [slugs.a]: 'a',
    [slugs.b]: 'b',
  };

  router.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  router.get('/', (req, res) => {
    const cookies = parseCookie(req.headers.cookie ?? '');
    const side = cookies.side === 'b' ? 'b' : 'a';
    if (!cookies.side) {
      res.setHeader('Set-Cookie', serializeCookie('side', side, {
        path: '/', sameSite: 'lax', httpOnly: false, maxAge: 60 * 60 * 24 * 365,
      }));
    }
    res.redirect(`/${slugs[side]}`);
  });

  function serveIndex(res, side) {
    res.setHeader('Set-Cookie', serializeCookie('side', side, {
      path: '/', sameSite: 'lax', maxAge: 31536000,
    }));
    res.type('html').send(renderIndex(side, sideNames));
  }

  router.get('/:slug', (req, res, next) => {
    const side = sideBySlug[req.params.slug];
    if (!side) return next();
    serveIndex(res, side);
  });

  router.get('/api/state', requireSide, async (req, res) => {
    const session = ensureSession(db);
    const deck = await buildDeck(places, session);
    const mySwipes = getSwipes(db, session.id, session.phase).filter(s => s.side === req.side);
    const partnerOnline = hub.isOnline(req.side === 'a' ? 'b' : 'a');
    res.json({
      phase: session.phase,
      matchedCuisine: session.matchedCuisine,
      matchedRestaurant: session.matchedRestaurantJson ? JSON.parse(session.matchedRestaurantJson) : null,
      deck,
      mySwipes,
      partnerOnline,
      mySide: req.side,
      myName: sideNames[req.side],
      partnerName: sideNames[req.side === 'a' ? 'b' : 'a'],
    });
  });

  router.post('/api/swipe', requireSide, async (req, res) => {
    const { itemId, direction } = req.body ?? {};
    if (direction !== 'left' && direction !== 'right') {
      return res.status(400).json({ error: 'direction must be left or right' });
    }
    if (typeof itemId !== 'string' || !itemId) {
      return res.status(400).json({ error: 'itemId required' });
    }
    const session = ensureSession(db);
    const result = recordSwipe(db, {
      sessionId: session.id,
      side: req.side,
      phase: session.phase,
      itemId,
      direction,
    });
    if (!result.matched) return res.json({ matched: false });

    let matchItem;
    if (session.phase === 'cuisines') {
      matchItem = cuisineById(itemId);
      advanceOnMatch(db, { sessionId: session.id, phase: 'cuisines', match: matchItem });
      const restaurants = await restaurantsForCuisine(places, itemId);
      hub.broadcast({ type: 'match', phase: 'cuisines', item: matchItem });
      hub.broadcast({ type: 'phase-change', phase: 'restaurants', deck: restaurants });
    } else if (session.phase === 'restaurants') {
      const restaurants = await restaurantsForCuisine(places, session.matchedCuisine);
      matchItem = restaurants.find(r => r.id === itemId);
      if (!matchItem) return res.status(404).json({ error: 'unknown restaurant' });
      advanceOnMatch(db, { sessionId: session.id, phase: 'restaurants', match: matchItem });
      hub.broadcast({ type: 'match', phase: 'restaurants', item: matchItem });
    }
    res.json({ matched: true });
  });

  router.post('/api/reset', requireSide, async (req, res) => {
    const { scope } = req.body ?? {};
    const session = ensureSession(db);
    if (scope === 'phase') {
      resetPhase(db, session.id, session.phase);
      let deck;
      if (session.phase === 'cuisines') deck = CUISINES;
      else if (session.phase === 'restaurants') deck = await restaurantsForCuisine(places, session.matchedCuisine);
      else deck = [];
      hub.broadcast({ type: 'phase-reset', phase: session.phase, deck });
      return res.json({ ok: true });
    }
    if (scope === 'session') {
      resetSession(db);
      hub.broadcast({ type: 'session-reset' });
      return res.json({ ok: true });
    }
    res.status(400).json({ error: 'scope must be phase or session' });
  });

  router.get('/api/events', requireSide, (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write(': connected\n\n');
    hub.register(req.side, res);
    hub.broadcast({ type: 'partner-online', side: req.side, online: true });
    req.on('close', () => {
      hub.unregister(req.side, res);
      hub.broadcast({ type: 'partner-online', side: req.side, online: false });
    });
  });

  // Photo proxy is stateless — no side required (frontend img tags can't send query params reliably anyway).
  // Express 5 dropped string wildcards; pass a RegExp instead.
  router.get(/^\/api\/photo\/(.+)$/, async (req, res) => {
    const name = req.params[0];
    try {
      const { body, contentType } = await places.fetchPhoto(name);
      res.set('Content-Type', contentType);
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(Buffer.from(body));
    } catch {
      res.status(400).end();
    }
  });

  router.use(express.static(PUBLIC_DIR));

  return router;
}
