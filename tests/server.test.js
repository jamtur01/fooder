import { describe, it, expect } from 'vitest';
import { validateEnv } from '../server.js';

describe('validateEnv', () => {
  it('throws naming the missing var', () => {
    expect(() => validateEnv({})).toThrow(/GOOGLE_PLACES_API_KEY/);
  });
  it('returns normalized config when complete', () => {
    const cfg = validateEnv({
      GOOGLE_PLACES_API_KEY: 'KEY',
      HOME_LAT: '37.4',
      HOME_LNG: '-122.0',
      SEARCH_RADIUS_METERS: '5000',
      PORT: '8080',
      DB_PATH: '/tmp/x.db',
    });
    expect(cfg.apiKey).toBe('KEY');
    expect(cfg.home).toEqual({ lat: 37.4, lng: -122.0 });
    expect(cfg.radiusMeters).toBe(5000);
    expect(cfg.port).toBe(8080);
    expect(cfg.dbPath).toBe('/tmp/x.db');
  });
  it('applies defaults for optional vars', () => {
    const cfg = validateEnv({
      GOOGLE_PLACES_API_KEY: 'KEY',
      HOME_LAT: '0',
      HOME_LNG: '0',
    });
    expect(cfg.radiusMeters).toBe(5000);
    expect(cfg.dbPath).toBe('/data/fooder.db');
  });
  it('rejects non-numeric HOME_LAT', () => {
    expect(() => validateEnv({
      GOOGLE_PLACES_API_KEY: 'KEY',
      HOME_LAT: 'abc',
      HOME_LNG: '0',
    })).toThrow(/HOME_LAT/);
  });
});

import { loadFavorites } from '../server.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('loadFavorites', () => {
  it('returns {} when neither source is set', () => {
    expect(loadFavorites({ favoritesJson: null, favoritesFile: '/no/such/file.json' })).toEqual({});
  });
  it('prefers FAVORITES_JSON over file', () => {
    const file = path.join(os.tmpdir(), `fav-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ thai: ['FILE'] }));
    const result = loadFavorites({ favoritesJson: '{"thai":["ENV"]}', favoritesFile: file });
    expect(result.thai).toEqual(['ENV']);
    fs.unlinkSync(file);
  });
  it('falls back to file when JSON is malformed', () => {
    const file = path.join(os.tmpdir(), `fav-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify({ thai: ['FILE'] }));
    const result = loadFavorites({ favoritesJson: 'not json', favoritesFile: file });
    expect(result.thai).toEqual(['FILE']);
    fs.unlinkSync(file);
  });
  it('returns {} when JSON is malformed and no file', () => {
    expect(loadFavorites({ favoritesJson: 'bad', favoritesFile: '/no/file' })).toEqual({});
  });
});
