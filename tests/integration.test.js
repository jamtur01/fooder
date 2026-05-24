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

describe('full flow — cuisine bracket', () => {
  async function swipeAll(side, swipes) {
    for (const [itemId, direction] of swipes) {
      await request(app).post('/api/swipe').set('Cookie', `side=${side}`).send({ itemId, direction });
    }
  }
  async function swipeAllCuisines(side, rightItems) {
    const { CUISINES } = await import('../src/cuisines.js');
    const swipes = CUISINES.map(c => [c.id, rightItems.includes(c.id) ? 'right' : 'left']);
    await swipeAll(side, swipes);
  }

  it('0 overlap → stays in cuisines/swipe (server broadcast no-overlap)', async () => {
    await swipeAllCuisines('a', ['thai']);
    await swipeAllCuisines('b', ['pizza']);
    const row = db.prepare('SELECT phase, cuisine_stage FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('cuisines');
    expect(row.cuisine_stage).toBe('swipe');
  });

  it('1 overlap → advances directly to restaurants', async () => {
    await swipeAllCuisines('a', ['thai']);
    await swipeAllCuisines('b', ['thai']);
    const row = db.prepare('SELECT phase, matched_cuisine FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('restaurants');
    expect(row.matched_cuisine).toBe('thai');
  });

  it('3 overlap with a tie advances through multiple rounds into restaurants', async () => {
    await swipeAllCuisines('a', ['pizza', 'thai', 'japanese']);
    await swipeAllCuisines('b', ['pizza', 'thai', 'japanese']);
    let row = db.prepare('SELECT cuisine_stage FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.cuisine_stage).toBe('bracket');

    // Round 0: pairs (pizza, thai), (japanese bye). Tie on pair 0 → both advance.
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=a').send({ pairIndex: 0, pick: 'pizza' });
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=b').send({ pairIndex: 0, pick: 'thai' });

    // Round 1: survivors [pizza, thai, japanese] → pairs (pizza, thai), (japanese bye).
    // Both pick pizza → pizza wins.
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=a').send({ pairIndex: 0, pick: 'pizza' });
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=b').send({ pairIndex: 0, pick: 'pizza' });

    // Round 2: survivors [pizza, japanese]. Both pick pizza → bracket done.
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=a').send({ pairIndex: 0, pick: 'pizza' });
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=b').send({ pairIndex: 0, pick: 'pizza' });

    row = db.prepare('SELECT phase, matched_cuisine FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('restaurants');
    expect(row.matched_cuisine).toBe('pizza');
  });

  it('3-overlap bracket then restaurant match completes the full flow', async () => {
    await swipeAllCuisines('a', ['pizza', 'thai', 'japanese']);
    await swipeAllCuisines('b', ['pizza', 'thai', 'japanese']);
    // Vote pizza all the way (single-side preferred): A picks pizza, B picks pizza for each round.
    // Round 0 pair 0 (pizza, thai): pizza wins
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=a').send({ pairIndex: 0, pick: 'pizza' });
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=b').send({ pairIndex: 0, pick: 'pizza' });
    // Round 1 survivors [pizza, japanese] → pair 0 (pizza, japanese): pizza wins → bracket done
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=a').send({ pairIndex: 0, pick: 'pizza' });
    await request(app).post('/api/bracket-vote').set('Cookie', 'side=b').send({ pairIndex: 0, pick: 'pizza' });

    let row = db.prepare('SELECT phase, matched_cuisine FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('restaurants');

    // Restaurants flow: instant match. placesOverride returns [ChIJ1, ChIJ2].
    await request(app).post('/api/swipe').set('Cookie', 'side=a').send({ itemId: 'ChIJ1', direction: 'right' });
    const res = await request(app).post('/api/swipe').set('Cookie', 'side=b').send({ itemId: 'ChIJ1', direction: 'right' });
    expect(res.body.matched).toBe(true);
    row = db.prepare('SELECT phase, matched_restaurant_json FROM session ORDER BY id DESC LIMIT 1').get();
    expect(row.phase).toBe('done');
    expect(JSON.parse(row.matched_restaurant_json).name).toBe('Spicy Thai');
  });
});
