import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp } from './helpers.js';

let app, db;
beforeEach(() => { ({ app, db } = buildApp()); });

describe('GET /api/state', () => {
  it('auto-creates a session on first request and returns cuisine deck', async () => {
    const res = await request(app).get('/api/state').set('Cookie', 'side=a');
    expect(res.status).toBe(200);
    expect(res.body.phase).toBe('cuisines');
    expect(res.body.deck.length).toBeGreaterThan(0);
    expect(res.body.deck[0]).toHaveProperty('id');
    expect(res.body.mySwipes).toEqual([]);
    expect(res.body.partnerOnline).toBe(false);
  });
  it('returns 400 without side cookie', async () => {
    const res = await request(app).get('/api/state');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/swipe', () => {
  it('records swipe and returns matched:false on first side', async () => {
    const res = await request(app).post('/api/swipe').set('Cookie', 'side=a')
      .send({ itemId: 'thai', direction: 'right' });
    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(false);
  });
  it('emits match SSE and advances phase when both swipe right', async () => {
    await request(app).post('/api/swipe').set('Cookie', 'side=a').send({ itemId: 'thai', direction: 'right' });
    const res = await request(app).post('/api/swipe').set('Cookie', 'side=b').send({ itemId: 'thai', direction: 'right' });
    expect(res.body.matched).toBe(true);
    const row = db.prepare('SELECT phase, matched_cuisine FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('restaurants');
    expect(row.matched_cuisine).toBe('thai');
  });
  it('rejects invalid direction', async () => {
    const res = await request(app).post('/api/swipe').set('Cookie', 'side=a').send({ itemId: 'thai', direction: 'sideways' });
    expect(res.status).toBe(400);
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
