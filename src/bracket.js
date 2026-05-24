export function pairItemsForRound(items) {
  const pairs = [];
  for (let i = 0; i < items.length; i += 2) {
    pairs.push({
      pairIndex: pairs.length,
      itemA: items[i],
      itemB: i + 1 < items.length ? items[i + 1] : null,
    });
  }
  return pairs;
}
