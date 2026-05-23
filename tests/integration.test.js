import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { buildApp } from './helpers.js';

const restaurants = [
  { id: 'ChIJ1', name: 'Spicy Thai', address: '1 St', phone: null, mapsUrl: 'https://maps/1', rating: 4.5, priceLevel: 2, photoUrl: null },
  { id: 'ChIJ2', name: 'Thai Two', address: '2 St', phone: null, mapsUrl: 'https://maps/2', rating: 4.0, priceLevel: 1, photoUrl: null },
];

const placesOverride = {
  searchRestaurants: async () => restaurants,
  fetchPhoto: async () => ({ body: new ArrayBuffer(0), contentType: 'image/jpeg' }),
  fetchPlace: async (id) => restaurants.find(r => r.id === id) ?? null,
  getFavorites: async () => [],
};

let app, db;
beforeEach(() => { ({ app, db } = buildApp({ placesOverride })); });

async function swipe(side, itemId, direction) {
  return request(app).post('/api/swipe').set('Cookie', `side=${side}`).send({ itemId, direction });
}

describe('full flow', () => {
  it('cuisine match → restaurant match → done', async () => {
    // Both connect
    await request(app).get('/api/state').set('Cookie', 'side=a');
    await request(app).get('/api/state').set('Cookie', 'side=b');

    // Phase 1: A swipes left on pizza, right on thai. B swipes right on thai.
    await swipe('a', 'pizza', 'left');
    await swipe('a', 'thai', 'right');
    const m1 = await swipe('b', 'thai', 'right');
    expect(m1.body.matched).toBe(true);

    // Session should be in restaurants phase with matched_cuisine=thai
    const session = db.prepare('SELECT phase, matched_cuisine FROM session ORDER BY id DESC LIMIT 1').get();
    expect(session.phase).toBe('restaurants');
    expect(session.matched_cuisine).toBe('thai');

    // Phase 2: A swipes left on ChIJ1, right on ChIJ2. B swipes right on ChIJ2.
    await swipe('a', 'ChIJ1', 'left');
    await swipe('a', 'ChIJ2', 'right');
    const m2 = await swipe('b', 'ChIJ2', 'right');
    expect(m2.body.matched).toBe(true);

    const final = db.prepare('SELECT phase, matched_restaurant_json FROM session ORDER BY id DESC LIMIT 1').get();
    expect(final.phase).toBe('done');
    expect(JSON.parse(final.matched_restaurant_json).name).toBe('Thai Two');
  });

  it('GET /api/state after match returns the matched restaurant', async () => {
    await request(app).get('/api/state').set('Cookie', 'side=a');
    await swipe('a', 'thai', 'right');
    await swipe('b', 'thai', 'right');
    await swipe('a', 'ChIJ1', 'right');
    await swipe('b', 'ChIJ1', 'right');
    const res = await request(app).get('/api/state').set('Cookie', 'side=a');
    expect(res.body.phase).toBe('done');
    expect(res.body.matchedRestaurant.name).toBe('Spicy Thai');
  });
});
