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

describe('searchRestaurants — cache', () => {
  const placesPayload = (id) => ({
    ok: true, status: 200,
    json: async () => ({ places: [{ id, displayName: { text: id }, formattedAddress: '' }] }),
  });

  it('cache miss hits API and stores result', async () => {
    const fetch = vi.fn().mockResolvedValue(placesPayload('ChIJ1'));
    const client = makePlacesClient({ db, fetch, apiKey: 'KEY', home: { lat: 1, lng: 2 }, radiusMeters: 5000, now: () => 1000 });
    await client.searchRestaurants('thai');
    expect(fetch).toHaveBeenCalledOnce();
    const row = db.prepare('SELECT * FROM restaurant_cache').get();
    expect(row.cuisine).toBe('thai');
    expect(row.location).toBe('1,2');
  });

  it('cache hit within TTL skips API', async () => {
    const fetch = vi.fn().mockResolvedValue(placesPayload('ChIJ1'));
    const client = makePlacesClient({ db, fetch, apiKey: 'KEY', home: { lat: 1, lng: 2 }, radiusMeters: 5000, now: () => 1000 });
    await client.searchRestaurants('thai');
    fetch.mockClear();
    const r = await client.searchRestaurants('thai');
    expect(fetch).not.toHaveBeenCalled();
    expect(r[0].id).toBe('ChIJ1');
  });

  it('cache expired (>24h) re-fetches', async () => {
    let t = 1000;
    const fetch = vi.fn().mockResolvedValue(placesPayload('ChIJ1'));
    const client = makePlacesClient({ db, fetch, apiKey: 'KEY', home: { lat: 1, lng: 2 }, radiusMeters: 5000, now: () => t });
    await client.searchRestaurants('thai');
    t += 25 * 3600 * 1000;
    fetch.mockClear();
    await client.searchRestaurants('thai');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('API error returns stale cache if present', async () => {
    let t = 1000;
    const fetch = vi.fn().mockResolvedValueOnce(placesPayload('ChIJ1'));
    const client = makePlacesClient({ db, fetch, apiKey: 'KEY', home: { lat: 1, lng: 2 }, radiusMeters: 5000, now: () => t });
    await client.searchRestaurants('thai');
    t += 25 * 3600 * 1000;
    fetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const r = await client.searchRestaurants('thai');
    expect(r[0].id).toBe('ChIJ1');
  });

  it('API error with no cache throws', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const client = makePlacesClient({ db, fetch, apiKey: 'KEY', home: { lat: 1, lng: 2 }, radiusMeters: 5000, now: () => 1000 });
    await expect(client.searchRestaurants('thai')).rejects.toThrow(/Places API/);
  });
});

describe('fetchPhoto', () => {
  it('GETs Google place photo URL with key and returns body + content-type', async () => {
    const buf = new Uint8Array([1,2,3,4]);
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'image/jpeg']]),
      arrayBuffer: async () => buf.buffer,
    });
    const client = makePlacesClient({ db, fetch, apiKey: 'KEY', home: { lat: 0, lng: 0 }, radiusMeters: 5000, now: () => 1000 });
    const { body, contentType } = await client.fetchPhoto('places/ChIJ1/photos/AbCd');
    expect(fetch).toHaveBeenCalledOnce();
    const [url] = fetch.mock.calls[0];
    expect(url).toBe('https://places.googleapis.com/v1/places/ChIJ1/photos/AbCd/media?key=KEY&maxWidthPx=800');
    expect(contentType).toBe('image/jpeg');
    expect(Buffer.from(body)).toEqual(Buffer.from(buf));
  });

  it('rejects names without the places/.../photos/... shape', async () => {
    const client = makePlacesClient({ db, fetch: vi.fn(), apiKey: 'KEY', home: { lat: 0, lng: 0 }, radiusMeters: 5000, now: () => 1000 });
    await expect(client.fetchPhoto('../../etc/passwd')).rejects.toThrow();
  });
});

describe('getFavorites + fetchPlace', () => {
  const placePayload = (id) => ({
    ok: true, status: 200,
    json: async () => ({ id, displayName: { text: 'Fav ' + id }, formattedAddress: 'addr ' + id }),
  });

  it('getFavorites returns [] when no favorites configured for cuisine', async () => {
    const client = makePlacesClient({
      db, fetch: vi.fn(), apiKey: 'K', home: { lat: 0, lng: 0 },
      radiusMeters: 5000, now: () => 1, favorites: {},
    });
    expect(await client.getFavorites('thai')).toEqual([]);
  });

  it('getFavorites fetches each Place ID and returns enriched objects', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(placePayload('ChIJX'))
      .mockResolvedValueOnce(placePayload('ChIJY'));
    const client = makePlacesClient({
      db, fetch, apiKey: 'K', home: { lat: 0, lng: 0 }, radiusMeters: 5000,
      now: () => 1, favorites: { thai: ['ChIJX', 'ChIJY'] },
    });
    const result = await client.getFavorites('thai');
    expect(result.map(r => r.id)).toEqual(['ChIJX', 'ChIJY']);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe('https://places.googleapis.com/v1/places/ChIJX');
    expect(fetch.mock.calls[0][1].headers['X-Goog-Api-Key']).toBe('K');
    expect(fetch.mock.calls[0][1].headers['X-Goog-FieldMask']).toContain('displayName');
  });

  it('fetchPlace caches result within TTL', async () => {
    const fetch = vi.fn().mockResolvedValue(placePayload('ChIJZ'));
    const client = makePlacesClient({
      db, fetch, apiKey: 'K', home: { lat: 0, lng: 0 }, radiusMeters: 5000,
      now: () => 1000, favorites: {},
    });
    await client.fetchPlace('ChIJZ');
    fetch.mockClear();
    await client.fetchPlace('ChIJZ');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('getFavorites skips entries whose fetch fails', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(placePayload('GOOD'))
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    const client = makePlacesClient({
      db, fetch, apiKey: 'K', home: { lat: 0, lng: 0 }, radiusMeters: 5000,
      now: () => 1, favorites: { thai: ['GOOD', 'BAD'] },
    });
    const result = await client.getFavorites('thai');
    expect(result.map(r => r.id)).toEqual(['GOOD']);
  });
});
