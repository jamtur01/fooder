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
  isDeckExhausted,
  setSessionDeck,
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

// Favorites failures are non-fatal (handled per-place inside getFavorites); a search
// failure degrades to a favorites-only deck plus an error the client can surface.
async function fetchRestaurantDeck(places, cuisine) {
  const [favorites, search] = await Promise.allSettled([
    places.getFavorites(cuisine),
    places.searchRestaurants(cuisine),
  ]);
  const favs = favorites.status === 'fulfilled' ? favorites.value : [];
  const seen = new Set(favs.map(r => r.id));
  const searched = search.status === 'fulfilled' ? search.value.filter(r => !seen.has(r.id)) : [];
  const error = search.status === 'rejected'
    ? `restaurant search failed: ${search.reason?.message ?? search.reason}`
    : null;
  return { deck: [...favs, ...searched], error };
}

function cuisineById(id) { return CUISINES.find(c => c.id === id); }

function sideDone(db, sessionId, phase, deckIds, side) {
  if (deckIds.length === 0) return false;
  const swiped = new Set(
    getSwipes(db, sessionId, phase).filter(s => s.side === side).map(s => s.itemId),
  );
  return deckIds.every(id => swiped.has(id));
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

  // Dedupes concurrent cold-cache fetches for the same session.
  const deckFetches = new Map();

  async function ensureRestaurantDeck(session) {
    if (session.deckJson) return { deck: JSON.parse(session.deckJson), error: null };
    let inflight = deckFetches.get(session.id);
    if (!inflight) {
      inflight = fetchRestaurantDeck(places, session.matchedCuisine)
        .finally(() => deckFetches.delete(session.id));
      deckFetches.set(session.id, inflight);
    }
    const { deck, error } = await inflight;
    // Snapshot only complete decks; an errored or empty result stays retryable.
    if (!error && deck.length > 0) setSessionDeck(db, session.id, deck);
    return { deck, error };
  }

  async function finishCuisines(session, matched) {
    const updated = advanceOnMatch(db, { sessionId: session.id, phase: 'cuisines', match: matched });
    await ensureRestaurantDeck(updated); // warm the snapshot; failures surface via /api/state deckError
    hub.broadcast({ type: 'match', phase: 'cuisines', item: matched });
    hub.broadcast({ type: 'phase-change', phase: 'restaurants' });
  }

  async function transitionAfterCuisineSwipes(session) {
    const overlap = computeCuisineOverlap(db, session.id, CUISINES.map(c => c.id));
    if (overlap.length === 0) {
      hub.broadcast({ type: 'stage-change', stage: 'no-overlap' });
      return;
    }
    if (overlap.length === 1) {
      await finishCuisines(session, cuisineById(overlap[0]));
      return;
    }
    createRound(db, session.id, 0, overlap);
    setCuisineStage(db, session.id, 'bracket');
    hub.broadcast({ type: 'stage-change', stage: 'bracket' });
  }

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
    const otherSide = req.side === 'a' ? 'b' : 'a';
    const mySwipes = getSwipes(db, session.id, session.phase).filter(s => s.side === req.side);

    let deck = [];
    let deckError = null;
    let stage = null;
    let bracket = null;
    let partnerDone = false;

    if (session.phase === 'cuisines') {
      deck = CUISINES;
      stage = session.cuisineStage;
      const deckIds = CUISINES.map(c => c.id);
      partnerDone = sideDone(db, session.id, 'cuisines', deckIds, otherSide);
      if (stage === 'swipe'
          && isDeckExhausted(db, session.id, 'cuisines', deckIds)
          && computeCuisineOverlap(db, session.id, deckIds).length === 0) {
        stage = 'no-overlap';
      }
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
    } else if (session.phase === 'restaurants') {
      ({ deck, error: deckError } = await ensureRestaurantDeck(session));
      partnerDone = sideDone(db, session.id, 'restaurants', deck.map(r => r.id), otherSide);
    }

    res.json({
      phase: session.phase,
      stage,
      deckError,
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

    if (session.phase === 'done') {
      return res.status(400).json({ error: 'session already matched' });
    }
    if (session.phase === 'cuisines' && session.cuisineStage === 'bracket') {
      return res.status(400).json({ error: 'cannot swipe during bracket stage; use /api/bracket-vote' });
    }

    const result = recordSwipe(db, {
      sessionId: session.id, side: req.side, phase: session.phase, itemId, direction,
    });

    if (session.phase === 'cuisines') {
      const deckIds = CUISINES.map(c => c.id);
      if (sideDone(db, session.id, 'cuisines', deckIds, req.side)) {
        hub.broadcast({ type: 'partner-done', side: req.side });
      }
      if (isDeckExhausted(db, session.id, 'cuisines', deckIds)) {
        await transitionAfterCuisineSwipes(session);
      }
      return res.json({ matched: false });
    }

    // restaurants phase
    const { deck } = await ensureRestaurantDeck(session);
    if (sideDone(db, session.id, 'restaurants', deck.map(r => r.id), req.side)) {
      hub.broadcast({ type: 'partner-done', side: req.side });
    }
    if (!result.matched) return res.json({ matched: false });
    const matchItem = deck.find(r => r.id === itemId);
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
      await finishCuisines(session, cuisineById(next.winner));
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
        } else {
          setCuisineStage(db, session.id, 'swipe');
        }
        hub.broadcast({ type: 'phase-reset', phase: 'cuisines' });
        return res.json({ ok: true });
      }

      resetPhase(db, session.id, session.phase);
      hub.broadcast({ type: 'phase-reset', phase: session.phase });
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
