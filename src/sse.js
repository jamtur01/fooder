export function createSseHub({ heartbeatMs = 25000 } = {}) {
  const conns = { a: new Set(), b: new Set() };
  let heartbeat = null;

  function isOnline(side) { return conns[side].size > 0; }

  function eachClient(fn) {
    for (const side of ['a', 'b']) {
      for (const client of conns[side]) fn(client);
    }
  }

  // Proxies (Railway et al.) kill idle SSE connections; comment pings keep them alive.
  function startHeartbeat() {
    if (heartbeat) return;
    heartbeat = setInterval(() => eachClient(c => c.write(': ping\n\n')), heartbeatMs);
    heartbeat.unref?.();
  }

  function stopHeartbeatIfIdle() {
    if (heartbeat && conns.a.size + conns.b.size === 0) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function register(side, client) {
    conns[side].add(client);
    startHeartbeat();
  }

  function unregister(side, client) {
    conns[side].delete(client);
    stopHeartbeatIfIdle();
  }

  function broadcast(event) {
    const chunk = `data: ${JSON.stringify(event)}\n\n`;
    eachClient(c => c.write(chunk));
  }

  return { register, unregister, broadcast, isOnline };
}
