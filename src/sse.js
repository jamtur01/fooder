export function createSseHub() {
  const conns = { a: new Set(), b: new Set() };
  const changeListeners = new Set();

  function isOnline(side) { return conns[side].size > 0; }

  function notifyChange(side, online) {
    for (const fn of changeListeners) fn(side, online);
  }

  function register(side, client) {
    const wasOnline = isOnline(side);
    conns[side].add(client);
    if (!wasOnline) notifyChange(side, true);
  }

  function unregister(side, client) {
    conns[side].delete(client);
    if (!isOnline(side)) notifyChange(side, false);
  }

  function broadcast(event) {
    const chunk = `data: ${JSON.stringify(event)}\n\n`;
    for (const side of ['a', 'b']) {
      for (const client of conns[side]) client.write(chunk);
    }
  }

  function sendTo(side, event) {
    const chunk = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of conns[side]) client.write(chunk);
  }

  function onChange(fn) { changeListeners.add(fn); }

  return { register, unregister, broadcast, sendTo, onChange, isOnline };
}
