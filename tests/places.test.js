import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../src/db.js';
import { makePlacesClient } from '../src/places.js';

let db;
beforeEach(() => { db = openDb(':memory:'); });

const sampleResponse = {
  places: [
    {
      id: 'ChIJ1',
      displayName: { text: 'Spicy Thai' },
      formattedAddress: '123 Main St',
      rating: 4.5,
      priceLevel: 'PRICE_LEVEL_MODERATE',
      nationalPhoneNumber: '+1 555 111 2222',
      googleMapsUri: 'https://maps.google.com/?cid=1',
      photos: [{ name: 'places/ChIJ1/photos/AbCd' }],
    },
  ],
};

describe('searchRestaurants', () => {
  it('POSTs to Places (New) with correct body, headers, field mask', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => sampleResponse,
    });
    const client = makePlacesClient({
      db, fetch,
      apiKey: 'KEY',
      home: { lat: 37.4, lng: -122.0 },
      radiusMeters: 5000,
      now: () => 1000,
    });
    const result = await client.searchRestaurants('thai');
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://places.googleapis.com/v1/places:searchText');
    expect(init.method).toBe('POST');
    expect(init.headers['X-Goog-Api-Key']).toBe('KEY');
    expect(init.headers['X-Goog-FieldMask']).toContain('places.displayName');
    const body = JSON.parse(init.body);
    expect(body.textQuery).toBe('thai restaurants');
    expect(body.locationBias.circle.center).toEqual({ latitude: 37.4, longitude: -122.0 });
    expect(body.locationBias.circle.radius).toBe(5000);
    expect(body.maxResultCount).toBe(10);
    expect(body.openNow).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: 'ChIJ1',
      name: 'Spicy Thai',
      address: '123 Main St',
      phone: '+1 555 111 2222',
      mapsUrl: 'https://maps.google.com/?cid=1',
      rating: 4.5,
      priceLevel: 2,
      photoUrl: '/api/photo/places/ChIJ1/photos/AbCd',
    });
  });

  it('normalizes missing fields to null', async () => {
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ places: [{ id: 'ChIJ2', displayName: { text: 'Bare' }, formattedAddress: '1 St' }] }),
    });
    const client = makePlacesClient({ db, fetch, apiKey: 'KEY', home: { lat: 0, lng: 0 }, radiusMeters: 5000, now: () => 1000 });
    const [r] = await client.searchRestaurants('thai');
    expect(r.rating).toBeNull();
    expect(r.priceLevel).toBeNull();
    expect(r.phone).toBeNull();
    expect(r.photoUrl).toBeNull();
  });

  it('returns empty array when Places returns no places key', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    const client = makePlacesClient({ db, fetch, apiKey: 'KEY', home: { lat: 0, lng: 0 }, radiusMeters: 5000, now: () => 1000 });
    expect(await client.searchRestaurants('thai')).toEqual([]);
  });
});
