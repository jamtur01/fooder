import { describe, it, expect } from 'vitest';
import { pairItemsForRound } from '../src/bracket.js';

describe('pairItemsForRound', () => {
  it('returns [] for empty input', () => {
    expect(pairItemsForRound([])).toEqual([]);
  });
  it('returns one pair for two items', () => {
    expect(pairItemsForRound(['thai', 'sushi']))
      .toEqual([{ pairIndex: 0, itemA: 'thai', itemB: 'sushi' }]);
  });
  it('pairs sequentially in deck order for even counts', () => {
    expect(pairItemsForRound(['a','b','c','d']))
      .toEqual([
        { pairIndex: 0, itemA: 'a', itemB: 'b' },
        { pairIndex: 1, itemA: 'c', itemB: 'd' },
      ]);
  });
  it('gives the last item a bye for odd counts (itemB === null)', () => {
    expect(pairItemsForRound(['a','b','c']))
      .toEqual([
        { pairIndex: 0, itemA: 'a', itemB: 'b' },
        { pairIndex: 1, itemA: 'c', itemB: null },
      ]);
  });
});
