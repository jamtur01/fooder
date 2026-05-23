import { describe, it, expect } from 'vitest';
import { CUISINES } from '../src/cuisines.js';

describe('CUISINES', () => {
  it('has at least 12 entries', () => {
    expect(CUISINES.length).toBeGreaterThanOrEqual(12);
  });
  it('each has id, name, emoji', () => {
    for (const c of CUISINES) {
      expect(c.id).toMatch(/^[a-z][a-z0-9_-]+$/);
      expect(c.name).toBeTruthy();
      expect(c.emoji).toBeTruthy();
    }
  });
  it('ids are unique', () => {
    const ids = new Set(CUISINES.map(c => c.id));
    expect(ids.size).toBe(CUISINES.length);
  });
});
