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
  bothDoneSwipingCuisines,
  computeCuisineOverlap,
  setCuisineStage,
} from './session.js';
import { createRound, getCurrentPair, recordBracketVote, buildNextRound } from './bracket.js';

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

async function transitionFromSwipeToBracket({
  db, session, places, hub, CUISINES: cuisineList, cuisineById: byId, advanceOnMatch: advance,
  restaurantsForCuisine: restaurants,
}) {
  const overlap = computeCuisineOverlap(db, session.id, cuisineList.map(c => c.id));
  if (overlap.length === 0) {
    hub.broadcast({ type: 'stage-change', stage: 'no-overlap' });
    return;
  }
  if (overlap.length === 1) {
    const matched = byId(overlap[0]);
    advance(db, { sessionId: session.id, phase: 'cuisines', match: matched });
    const restaurantList = await restaurants(places, matched.id);
    hub.broadcast({ type: 'match', phase: 'cuisines', item: matched });
    hub.broadcast({ type: 'phase-change', phase: 'restaurants', deck: restaurantList });
    return;
  }
  createRound(db, session.id, 0, overlap);
  setCuisineStage(db, session.id, 'bracket');
  const cur = getCurrentPair(db, session.id);
  hub.broadcast({
    type: 'stage-change',
    stage: 'bracket',
    bracket: {
      roundIndex: cur.roundIndex,
      currentPair: {
        pairIndex: cur.pairIndex,
        a: byId(cur.itemA),
        b: cur.itemB ? byId(cur.itemB) : null,
      },
    },
  });
}

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

    let stage = null;
    let bracket = null;
    let partnerDone = false;

    if (session.phase === 'cuisines') {
      stage = session.cuisineStage;
      const otherSide = req.side === 'a' ? 'b' : 'a';
      const otherSwipes = getSwipes(db, session.id, 'cuisines').filter(s => s.side === otherSide);
      partnerDone = otherSwipes.length >= CUISINES.length;
      if (stage === 'bracket') {
        const cur = getCurrentPair(db, session.id);
        const myVoteRow = cur ? db.prepare(
          'SELECT pick FROM bracket_vote WHERE session_id=? AND round_index=? AND pair_index=? AND side=?'
        ).get(session.id, cur.roundIndex, cur.pairIndex, req.side) : null;
        bracket = {
          roundIndex: cur ? cur.roundIndex : 0,
          currentPair: cur
            ? { pairIndex: cur.pairIndex, a: cuisineById(cur.itemA), b: cur.itemB ? cuisineById(cur.itemB) : null }
            : null,
          myVote: myVoteRow?.pick ?? null,
        };
      }
    }

    res.json({
      phase: session.phase,
      stage,
      matchedCuisine: session.matchedCuisine,
      matchedRestaurant: session.matchedRestaurantJson ? JSON.parse(session.matchedRestaurantJson) : null,
      deck,
      mySwipes,
      partnerOnline: hub.isOnline(req.side === 'a' ? 'b' : 'a'),
      partnerDone,
      bracket,
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

    if (session.phase === 'cuisines' && session.cuisineStage === 'bracket') {
      return res.status(400).json({ error: 'cannot swipe during bracket stage; use /api/bracket-vote' });
    }

    const result = recordSwipe(db, {
      sessionId: session.id, side: req.side, phase: session.phase, itemId, direction,
    });

    if (session.phase === 'cuisines') {
      const mineCount = getSwipes(db, session.id, 'cuisines').filter(s => s.side === req.side).length;
      if (mineCount === CUISINES.length) {
        hub.broadcast({ type: 'partner-done', side: req.side, swipedCount: mineCount });
      }
      if (bothDoneSwipingCuisines(db, session.id, CUISINES.map(c => c.id))) {
        await transitionFromSwipeToBracket({
          db, session, places, hub,
          CUISINES,
          cuisineById,
          advanceOnMatch,
          restaurantsForCuisine,
        });
      }
      return res.json({ matched: false });
    }

    // restaurants phase
    if (!result.matched) return res.json({ matched: false });
    const restaurants = await restaurantsForCuisine(places, session.matchedCuisine);
    const matchItem = restaurants.find(r => r.id === itemId);
    if (!matchItem) return res.status(404).json({ error: 'unknown restaurant' });
    advanceOnMatch(db, { sessionId: session.id, phase: 'restaurants', match: matchItem });
    hub.broadcast({ type: 'match', phase: 'restaurants', item: matchItem });
    res.json({ matched: true });
  });

  router.post('/api/bracket-vote', requireSide, async (req, res) => {
    const { pairIndex, pick } = req.body ?? {};
    if (typeof pairIndex !== 'number' || typeof pick !== 'string') {
      return res.status(400).json({ error: 'pairIndex (number) and pick (string) required' });
    }
    const session = ensureSession(db);
    if (session.phase !== 'cuisines' || session.cuisineStage !== 'bracket') {
      return res.status(400).json({ error: 'bracket vote only valid in cuisines bracket stage' });
    }

    let result;
    try {
      result = recordBracketVote(db, session.id, { side: req.side, pairIndex, pick });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    hub.broadcast({ type: 'bracket-vote-cast', side: req.side, pairIndex });

    if (!result.resolved) return res.json({ resolved: false });

    hub.broadcast({
      type: 'bracket-pair-resolved',
      pairIndex,
      outcome: result.outcome,
      winner: result.winners.length === 1 ? result.winners[0] : null,
    });

    if (getCurrentPair(db, session.id)) return res.json({ resolved: true });

    const deckOrder = CUISINES.map(c => c.id);
    const next = buildNextRound(db, session.id, deckOrder);

    if (next.done) {
      const matched = cuisineById(next.winner);
      advanceOnMatch(db, { sessionId: session.id, phase: 'cuisines', match: matched });
      const restaurants = await restaurantsForCuisine(places, matched.id);
      hub.broadcast({ type: 'match', phase: 'cuisines', item: matched });
      hub.broadcast({ type: 'phase-change', phase: 'restaurants', deck: restaurants });
      return res.json({ resolved: true, done: true });
    }

    const cur = getCurrentPair(db, session.id);
    hub.broadcast({
      type: 'bracket-round-start',
      roundIndex: cur.roundIndex,
      currentPair: {
        pairIndex: cur.pairIndex,
        a: cuisineById(cur.itemA),
        b: cur.itemB ? cuisineById(cur.itemB) : null,
      },
    });
    res.json({ resolved: true });
  });

  router.post('/api/reset', requireSide, async (req, res) => {
    const { scope } = req.body ?? {};
    const session = ensureSession(db);
    if (scope === 'phase') {
      if (session.phase === 'cuisines' && session.cuisineStage === 'bracket') {
        db.prepare('DELETE FROM bracket_vote WHERE session_id=?').run(session.id);
        db.prepare('DELETE FROM bracket_round WHERE session_id=?').run(session.id);
        const overlap = computeCuisineOverlap(db, session.id, CUISINES.map(c => c.id));
        if (overlap.length >= 2) {
          createRound(db, session.id, 0, overlap);
          const cur = getCurrentPair(db, session.id);
          hub.broadcast({
            type: 'phase-reset',
            phase: 'cuisines',
            bracket: {
              roundIndex: cur.roundIndex,
              currentPair: {
                pairIndex: cur.pairIndex,
                a: cuisineById(cur.itemA),
                b: cur.itemB ? cuisineById(cur.itemB) : null,
              },
            },
          });
        } else {
          setCuisineStage(db, session.id, 'swipe');
          hub.broadcast({ type: 'phase-reset', phase: 'cuisines', deck: CUISINES });
        }
        return res.json({ ok: true });
      }

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
