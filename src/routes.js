import express from 'express';
import { parse as parseCookie } from 'cookie';
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

function sideOf(req) {
  const cookies = parseCookie(req.headers.cookie ?? '');
  return cookies.side;
}

function requireSide(req, res, next) {
  const side = sideOf(req);
  if (side !== 'a' && side !== 'b') {
    return res.status(400).json({ error: 'side cookie required (a or b)' });
  }
  req.side = side;
  next();
}

function ensureSession(db) {
  const s = getCurrentSession(db);
  if (s) return s;
  return createSession(db);
}

async function buildDeck(places, session) {
  if (session.phase === 'cuisines') return CUISINES;
  if (session.phase === 'restaurants') {
    return places.searchRestaurants(session.matchedCuisine);
  }
  return [];
}

function cuisineById(id) { return CUISINES.find(c => c.id === id); }

export function makeRouter({ db, places, hub }) {
  const router = express.Router();

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
      const restaurants = await places.searchRestaurants(itemId);
      hub.broadcast({ type: 'match', phase: 'cuisines', item: matchItem });
      hub.broadcast({ type: 'phase-change', phase: 'restaurants', deck: restaurants });
    } else if (session.phase === 'restaurants') {
      const restaurants = await places.searchRestaurants(session.matchedCuisine);
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
      else if (session.phase === 'restaurants') deck = await places.searchRestaurants(session.matchedCuisine);
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

  // Express 5 dropped string wildcards; pass a RegExp instead.
  router.get(/^\/api\/photo\/(.+)$/, requireSide, async (req, res) => {
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

  return router;
}
