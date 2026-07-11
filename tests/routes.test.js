import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from './helpers.js';

let db, agent;
beforeEach(() => { ({ db, agent } = buildApp()); });

describe('GET /api/state', () => {
  it('returns the cuisines deck with stage=swipe, partnerDone=false, bracket=null', async () => {
    const res = await agent.get('/api/state').set('Cookie', 'side=a');
    expect(res.status).toBe(200);
    expect(res.body.phase).toBe('cuisines');
    expect(res.body.stage).toBe('swipe');
    expect(res.body.deck.length).toBeGreaterThan(0);
    expect(res.body.partnerDone).toBe(false);
    expect(res.body.bracket).toBeNull();
  });

  it('returns partnerDone=true once the other side has swiped every cuisine', async () => {
    const { CUISINES } = await import('../src/cuisines.js');
    for (const c of CUISINES) {
      await agent.post('/api/swipe').set('Cookie', 'side=b').send({ itemId: c.id, direction: 'left' });
    }
    const res = await agent.get('/api/state').set('Cookie', 'side=a');
    expect(res.body.partnerDone).toBe(true);
  });

  it('returns 400 without side cookie', async () => {
    const res = await agent.get('/api/state');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/swipe', () => {
  it('records swipe and returns matched:false on first side (cuisines)', async () => {
    const res = await agent.post('/api/swipe').set('Cookie', 'side=a')
      .send({ itemId: 'thai', direction: 'right' });
    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(false);
  });

  it('cuisines phase no longer instant-matches when both right-swipe same item', async () => {
    await agent.post('/api/swipe').set('Cookie', 'side=a').send({ itemId: 'thai', direction: 'right' });
    const res = await agent.post('/api/swipe').set('Cookie', 'side=b').send({ itemId: 'thai', direction: 'right' });
    expect(res.body.matched).toBe(false);
    const row = db.prepare('SELECT phase, cuisine_stage FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('cuisines');
    expect(row.cuisine_stage).toBe('swipe');
  });

  it('rejects invalid direction', async () => {
    const res = await agent.post('/api/swipe').set('Cookie', 'side=a').send({ itemId: 'thai', direction: 'sideways' });
    expect(res.status).toBe(400);
  });

  it('1 overlap → both done → server advances directly to restaurants', async () => {
    const { CUISINES } = await import('../src/cuisines.js');
    // Both right-swipe ONLY thai; left on the rest.
    for (const c of CUISINES) {
      const dir = c.id === 'thai' ? 'right' : 'left';
      await agent.post('/api/swipe').set('Cookie', 'side=a').send({ itemId: c.id, direction: dir });
      await agent.post('/api/swipe').set('Cookie', 'side=b').send({ itemId: c.id, direction: dir });
    }
    const row = db.prepare('SELECT phase, matched_cuisine FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('restaurants');
    expect(row.matched_cuisine).toBe('thai');
  });

  it('2+ overlap → both done → server creates bracket round 0', async () => {
    const { CUISINES } = await import('../src/cuisines.js');
    const overlap = new Set(['thai', 'pizza']);
    for (const c of CUISINES) {
      const dir = overlap.has(c.id) ? 'right' : 'left';
      await agent.post('/api/swipe').set('Cookie', 'side=a').send({ itemId: c.id, direction: dir });
      await agent.post('/api/swipe').set('Cookie', 'side=b').send({ itemId: c.id, direction: dir });
    }
    const row = db.prepare('SELECT phase, cuisine_stage FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('cuisines');
    expect(row.cuisine_stage).toBe('bracket');
    expect(db.prepare('SELECT COUNT(*) AS n FROM bracket_round').get().n).toBeGreaterThan(0);
  });
});

describe('POST /api/reset', () => {
  it('scope=phase clears current phase swipes', async () => {
    await agent.post('/api/swipe').set('Cookie', 'side=a').send({ itemId: 'thai', direction: 'right' });
    const res = await agent.post('/api/reset').set('Cookie', 'side=a').send({ scope: 'phase' });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM swipe').get().n).toBe(0);
  });
  it('scope=session creates a new session', async () => {
    await agent.get('/api/state').set('Cookie', 'side=a');
    const before = db.prepare('SELECT MAX(id) AS id FROM session').get().id;
    const res = await agent.post('/api/reset').set('Cookie', 'side=a').send({ scope: 'session' });
    expect(res.status).toBe(200);
    const after = db.prepare('SELECT MAX(id) AS id FROM session').get().id;
    expect(after).toBe(before + 1);
  });
  it('rejects unknown scope', async () => {
    const res = await agent.post('/api/reset').set('Cookie', 'side=a').send({ scope: 'nope' });
    expect(res.status).toBe(400);
  });
});

describe('side routing', () => {
  it('GET / with no cookie redirects to /a and sets cookie', async () => {
    const res = await agent.get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/a');
    expect(res.headers['set-cookie']?.[0]).toMatch(/side=a/);
  });
  it('GET / with side=b cookie redirects to /b', async () => {
    const res = await agent.get('/').set('Cookie', 'side=b');
    expect(res.headers.location).toBe('/b');
  });
  it('GET /a sets cookie and returns 200 (index.html)', async () => {
    const res = await agent.get('/a');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.[0]).toMatch(/side=a/);
  });
  it('GET /c is 404', async () => {
    const res = await agent.get('/c');
    expect(res.status).toBe(404);
  });
});

describe('side routing with named sides', () => {
  it('GET /james (slug of SIDE_A_NAME) serves index; /a 404s', async () => {
    const { agent: namedAgent } = buildApp({ sideNames: { a: 'James', b: 'Sarah' } });
    const ok = await namedAgent.get('/james');
    expect(ok.status).toBe(200);
    const fail = await namedAgent.get('/a');
    expect(fail.status).toBe(404);
  });
  it('GET / redirects to slug, not bare letter', async () => {
    const { agent: namedAgent } = buildApp({ sideNames: { a: 'James', b: 'Sarah' } });
    const res = await namedAgent.get('/');
    expect(res.headers.location).toBe('/james');
  });
});

describe('POST /api/reset — stage-aware in cuisines phase', () => {
  async function getIntoBracket(items) {
    const { CUISINES } = await import('../src/cuisines.js');
    for (const c of CUISINES) {
      const dir = items.includes(c.id) ? 'right' : 'left';
      await agent.post('/api/swipe').set('Cookie', 'side=a').send({ itemId: c.id, direction: dir });
      await agent.post('/api/swipe').set('Cookie', 'side=b').send({ itemId: c.id, direction: dir });
    }
  }

  it('scope=phase during stage=bracket clears bracket data but keeps cuisine swipes', async () => {
    await getIntoBracket(['thai', 'pizza', 'japanese']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bracket_round').get().n).toBeGreaterThan(0);
    const swipeCountBefore = db.prepare("SELECT COUNT(*) AS n FROM swipe WHERE phase='cuisines'").get().n;
    const res = await agent.post('/api/reset').set('Cookie', 'side=a').send({ scope: 'phase' });
    expect(res.status).toBe(200);
    expect(db.prepare("SELECT COUNT(*) AS n FROM swipe WHERE phase='cuisines'").get().n).toBe(swipeCountBefore);
    expect(db.prepare('SELECT MAX(round_index) AS r FROM bracket_round').get().r).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bracket_vote').get().n).toBe(0);
  });

  it('scope=phase during stage=swipe clears cuisine swipes (existing behavior)', async () => {
    await agent.post('/api/swipe').set('Cookie', 'side=a').send({ itemId: 'thai', direction: 'right' });
    const res = await agent.post('/api/reset').set('Cookie', 'side=a').send({ scope: 'phase' });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM swipe').get().n).toBe(0);
  });
});

describe('POST /api/bracket-vote', () => {
  async function getIntoBracketWithOverlap(items) {
    const { CUISINES } = await import('../src/cuisines.js');
    for (const c of CUISINES) {
      const dir = items.includes(c.id) ? 'right' : 'left';
      await agent.post('/api/swipe').set('Cookie', 'side=a').send({ itemId: c.id, direction: dir });
      await agent.post('/api/swipe').set('Cookie', 'side=b').send({ itemId: c.id, direction: dir });
    }
  }

  it('rejects vote before bracket stage', async () => {
    const res = await agent.post('/api/bracket-vote').set('Cookie', 'side=a')
      .send({ pairIndex: 0, pick: 'thai' });
    expect(res.status).toBe(400);
  });

  it('records vote and returns resolved:false on first side', async () => {
    await getIntoBracketWithOverlap(['thai', 'pizza']);
    const res = await agent.post('/api/bracket-vote').set('Cookie', 'side=a')
      .send({ pairIndex: 0, pick: 'thai' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ resolved: false });
  });

  it('resolves when both sides vote the same; advances phase if bracket is done', async () => {
    await getIntoBracketWithOverlap(['thai', 'pizza']);
    await agent.post('/api/bracket-vote').set('Cookie', 'side=a').send({ pairIndex: 0, pick: 'thai' });
    const res = await agent.post('/api/bracket-vote').set('Cookie', 'side=b').send({ pairIndex: 0, pick: 'thai' });
    expect(res.body.resolved).toBe(true);
    const row = db.prepare('SELECT phase, matched_cuisine FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('restaurants');
    expect(row.matched_cuisine).toBe('thai');
  });

  it('rejects malformed pick', async () => {
    await getIntoBracketWithOverlap(['thai', 'pizza']);
    const res = await agent.post('/api/bracket-vote').set('Cookie', 'side=a')
      .send({ pairIndex: 0, pick: 'mexican' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/state — flakiness regressions', () => {
  async function swipeAllCuisines(side, rightItems, viaAgent = agent) {
    const { CUISINES } = await import('../src/cuisines.js');
    for (const c of CUISINES) {
      const dir = rightItems.includes(c.id) ? 'right' : 'left';
      await viaAgent.post('/api/swipe').set('Cookie', `side=${side}`).send({ itemId: c.id, direction: dir });
    }
  }

  it('derives stage=no-overlap when both finished with zero overlap (reload-safe)', async () => {
    await swipeAllCuisines('a', ['thai']);
    await swipeAllCuisines('b', ['pizza']);
    const res = await agent.get('/api/state').set('Cookie', 'side=a');
    expect(res.body.phase).toBe('cuisines');
    expect(res.body.stage).toBe('no-overlap');
  });

  it('stage stays swipe while partner is not done', async () => {
    await swipeAllCuisines('a', ['thai']);
    const res = await agent.get('/api/state').set('Cookie', 'side=a');
    expect(res.body.stage).toBe('swipe');
  });
});

const R1 = { id: 'ChIJ1', name: 'Spicy Thai', address: '1 St', phone: null, mapsUrl: null, rating: 4.5, priceLevel: 2, photoUrl: null };
const R2 = { id: 'ChIJ2', name: 'Thai Two', address: '2 St', phone: null, mapsUrl: null, rating: 4.0, priceLevel: 1, photoUrl: null };
const R3 = { id: 'ChIJ3', name: 'Drifter', address: '3 St', phone: null, mapsUrl: null, rating: 3.9, priceLevel: 1, photoUrl: null };
const FAV = { id: 'ChIJfav', name: 'Old Faithful', address: '9 St', phone: null, mapsUrl: null, rating: 5, priceLevel: 2, photoUrl: null };

describe('restaurant deck snapshot and deckError', () => {
  async function reachRestaurants(agent) {
    const { CUISINES } = await import('../src/cuisines.js');
    for (const c of CUISINES) {
      const dir = c.id === 'thai' ? 'right' : 'left';
      await agent.post('/api/swipe').set('Cookie', 'side=a').send({ itemId: c.id, direction: dir });
      await agent.post('/api/swipe').set('Cookie', 'side=b').send({ itemId: c.id, direction: dir });
    }
  }

  it('snapshots deck at transition; search drift changes neither deck nor match lookup', async () => {
    let results = [R1, R2];
    const { agent: myAgent, db: myDb } = buildApp({ placesOverride: {
      searchRestaurants: async () => results,
      getFavorites: async () => [],
    } });
    await reachRestaurants(myAgent);
    results = [R3]; // upstream drift (cache expiry + openNow churn)

    const state = await myAgent.get('/api/state').set('Cookie', 'side=a');
    expect(state.body.deck.map(r => r.id)).toEqual(['ChIJ1', 'ChIJ2']);

    await myAgent.post('/api/swipe').set('Cookie', 'side=a').send({ itemId: 'ChIJ1', direction: 'right' });
    const res = await myAgent.post('/api/swipe').set('Cookie', 'side=b').send({ itemId: 'ChIJ1', direction: 'right' });
    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(true);
    const row = myDb.prepare('SELECT phase FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('done');
  });

  it('surfaces deckError with favorites-only deck when search fails', async () => {
    const { agent: myAgent } = buildApp({ placesOverride: {
      searchRestaurants: async () => { throw new Error('Places API 500'); },
      getFavorites: async () => [FAV],
    } });
    await reachRestaurants(myAgent);
    const res = await myAgent.get('/api/state').set('Cookie', 'side=a');
    expect(res.status).toBe(200);
    expect(res.body.deckError).toMatch(/Places API 500/);
    expect(res.body.deck.map(r => r.id)).toEqual(['ChIJfav']);
  });

  it('recovers the deck on a later state fetch after a transient search failure', async () => {
    let fail = true;
    const { agent: myAgent } = buildApp({ placesOverride: {
      searchRestaurants: async () => { if (fail) throw new Error('boom'); return [R1]; },
      getFavorites: async () => [],
    } });
    await reachRestaurants(myAgent); // transition happens while search is failing
    fail = false;
    const res = await myAgent.get('/api/state').set('Cookie', 'side=a');
    expect(res.body.deckError).toBeNull();
    expect(res.body.deck.map(r => r.id)).toEqual(['ChIJ1']);
  });

  it('partnerDone=true in restaurants phase once partner exhausted the deck', async () => {
    const { agent: myAgent } = buildApp({ placesOverride: {
      searchRestaurants: async () => [R1, R2],
      getFavorites: async () => [],
    } });
    await reachRestaurants(myAgent);
    await myAgent.post('/api/swipe').set('Cookie', 'side=b').send({ itemId: 'ChIJ1', direction: 'left' });
    await myAgent.post('/api/swipe').set('Cookie', 'side=b').send({ itemId: 'ChIJ2', direction: 'left' });
    const res = await myAgent.get('/api/state').set('Cookie', 'side=a');
    expect(res.body.partnerDone).toBe(true);
  });

  it('broadcasts partner-done when a side exhausts the restaurant deck', async () => {
    const { agent: myAgent, hub } = buildApp({ placesOverride: {
      searchRestaurants: async () => [R1, R2],
      getFavorites: async () => [],
    } });
    await reachRestaurants(myAgent);
    const writes = [];
    const client = { write: (chunk) => writes.push(chunk) };
    hub.register('a', client);
    await myAgent.post('/api/swipe').set('Cookie', 'side=b').send({ itemId: 'ChIJ1', direction: 'left' });
    await myAgent.post('/api/swipe').set('Cookie', 'side=b').send({ itemId: 'ChIJ2', direction: 'left' });
    const events = writes.filter(w => w.startsWith('data: ')).map(w => JSON.parse(w.slice(6)));
    expect(events.some(e => e.type === 'partner-done' && e.side === 'b')).toBe(true);
    hub.unregister('a', client);
  });
});
