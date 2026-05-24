import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp } from './helpers.js';

let app, db;
beforeEach(() => { ({ app, db } = buildApp()); });

describe('GET /api/state', () => {
  it('returns the cuisines deck with stage=swipe, partnerDone=false, bracket=null', async () => {
    const res = await request(app).get('/api/state').set('Cookie', 'side=a');
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
      await request(app).post('/api/swipe').set('Cookie', 'side=b').send({ itemId: c.id, direction: 'left' });
    }
    const res = await request(app).get('/api/state').set('Cookie', 'side=a');
    expect(res.body.partnerDone).toBe(true);
  });

  it('returns 400 without side cookie', async () => {
    const res = await request(app).get('/api/state');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/swipe', () => {
  it('records swipe and returns matched:false on first side (cuisines)', async () => {
    const res = await request(app).post('/api/swipe').set('Cookie', 'side=a')
      .send({ itemId: 'thai', direction: 'right' });
    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(false);
  });

  it('cuisines phase no longer instant-matches when both right-swipe same item', async () => {
    await request(app).post('/api/swipe').set('Cookie', 'side=a').send({ itemId: 'thai', direction: 'right' });
    const res = await request(app).post('/api/swipe').set('Cookie', 'side=b').send({ itemId: 'thai', direction: 'right' });
    expect(res.body.matched).toBe(false);
    const row = db.prepare('SELECT phase, cuisine_stage FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('cuisines');
    expect(row.cuisine_stage).toBe('swipe');
  });

  it('rejects invalid direction', async () => {
    const res = await request(app).post('/api/swipe').set('Cookie', 'side=a').send({ itemId: 'thai', direction: 'sideways' });
    expect(res.status).toBe(400);
  });

  it('1 overlap → both done → server advances directly to restaurants', async () => {
    const { CUISINES } = await import('../src/cuisines.js');
    // Both right-swipe ONLY thai; left on the rest.
    for (const c of CUISINES) {
      const dir = c.id === 'thai' ? 'right' : 'left';
      await request(app).post('/api/swipe').set('Cookie', 'side=a').send({ itemId: c.id, direction: dir });
      await request(app).post('/api/swipe').set('Cookie', 'side=b').send({ itemId: c.id, direction: dir });
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
      await request(app).post('/api/swipe').set('Cookie', 'side=a').send({ itemId: c.id, direction: dir });
      await request(app).post('/api/swipe').set('Cookie', 'side=b').send({ itemId: c.id, direction: dir });
    }
    const row = db.prepare('SELECT phase, cuisine_stage FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('cuisines');
    expect(row.cuisine_stage).toBe('bracket');
    expect(db.prepare('SELECT COUNT(*) AS n FROM bracket_round').get().n).toBeGreaterThan(0);
  });
});

describe('POST /api/reset', () => {
  it('scope=phase clears current phase swipes', async () => {
    await request(app).post('/api/swipe').set('Cookie', 'side=a').send({ itemId: 'thai', direction: 'right' });
    const res = await request(app).post('/api/reset').set('Cookie', 'side=a').send({ scope: 'phase' });
    expect(res.status).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM swipe').get().n).toBe(0);
  });
  it('scope=session creates a new session', async () => {
    await request(app).get('/api/state').set('Cookie', 'side=a');
    const before = db.prepare('SELECT MAX(id) AS id FROM session').get().id;
    const res = await request(app).post('/api/reset').set('Cookie', 'side=a').send({ scope: 'session' });
    expect(res.status).toBe(200);
    const after = db.prepare('SELECT MAX(id) AS id FROM session').get().id;
    expect(after).toBe(before + 1);
  });
  it('rejects unknown scope', async () => {
    const res = await request(app).post('/api/reset').set('Cookie', 'side=a').send({ scope: 'nope' });
    expect(res.status).toBe(400);
  });
});

describe('side routing', () => {
  it('GET / with no cookie redirects to /a and sets cookie', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/a');
    expect(res.headers['set-cookie']?.[0]).toMatch(/side=a/);
  });
  it('GET / with side=b cookie redirects to /b', async () => {
    const res = await request(app).get('/').set('Cookie', 'side=b');
    expect(res.headers.location).toBe('/b');
  });
  it('GET /a sets cookie and returns 200 (index.html)', async () => {
    const res = await request(app).get('/a');
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']?.[0]).toMatch(/side=a/);
  });
  it('GET /c is 404', async () => {
    const res = await request(app).get('/c');
    expect(res.status).toBe(404);
  });
});

describe('side routing with named sides', () => {
  it('GET /james (slug of SIDE_A_NAME) serves index; /a 404s', async () => {
    const { app: namedApp } = buildApp({ sideNames: { a: 'James', b: 'Sarah' } });
    const ok = await request(namedApp).get('/james');
    expect(ok.status).toBe(200);
    const fail = await request(namedApp).get('/a');
    expect(fail.status).toBe(404);
  });
  it('GET / redirects to slug, not bare letter', async () => {
    const { app: namedApp } = buildApp({ sideNames: { a: 'James', b: 'Sarah' } });
    const res = await request(namedApp).get('/');
    expect(res.headers.location).toBe('/james');
  });
});

describe('POST /api/bracket-vote', () => {
  async function getIntoBracketWithOverlap(items) {
    const { CUISINES } = await import('../src/cuisines.js');
    for (const c of CUISINES) {
      const dir = items.includes(c.id) ? 'right' : 'left';
      await request(app).post('/api/swipe').set('Cookie', 'side=a').send({ itemId: c.id, direction: dir });
      await request(app).post('/api/swipe').set('Cookie', 'side=b').send({ itemId: c.id, direction: dir });
    }
  }

  it('rejects vote before bracket stage', async () => {
    const res = await request(app).post('/api/bracket-vote').set('Cookie', 'side=a')
      .send({ pairIndex: 0, pick: 'thai' });
    expect(res.status).toBe(400);
  });

  it('records vote and returns resolved:false on first side', async () => {
    await getIntoBracketWithOverlap(['thai', 'pizza']);
    const res = await request(app).post('/api/bracket-vote').set('Cookie', 'side=a')
      .send({ pairIndex: 0, pick: 'thai' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ resolved: false });
  });

  it('resolves when both sides vote the same; advances phase if bracket is done', async () => {
    await getIntoBracketWithOverlap(['thai', 'pizza']);
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=a').send({ pairIndex: 0, pick: 'thai' });
    const res = await request(app).post('/api/bracket-vote').set('Cookie', 'side=b').send({ pairIndex: 0, pick: 'thai' });
    expect(res.body.resolved).toBe(true);
    const row = db.prepare('SELECT phase, matched_cuisine FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('restaurants');
    expect(row.matched_cuisine).toBe('thai');
  });

  it('rejects malformed pick', async () => {
    await getIntoBracketWithOverlap(['thai', 'pizza']);
    const res = await request(app).post('/api/bracket-vote').set('Cookie', 'side=a')
      .send({ pairIndex: 0, pick: 'mexican' });
    expect(res.status).toBe(400);
  });
});
