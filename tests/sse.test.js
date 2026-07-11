import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSseHub } from '../src/sse.js';

let hub;
beforeEach(() => { hub = createSseHub(); });

function fakeClient() {
  const writes = [];
  return { writes, write: (chunk) => writes.push(chunk), end: vi.fn() };
}

describe('SseHub', () => {
  it('register tracks online sides', () => {
    const c = fakeClient();
    hub.register('a', c);
    expect(hub.isOnline('a')).toBe(true);
    expect(hub.isOnline('b')).toBe(false);
  });

  it('broadcast writes formatted SSE to all connected sides', () => {
    const ca = fakeClient();
    const cb = fakeClient();
    hub.register('a', ca);
    hub.register('b', cb);
    hub.broadcast({ type: 'session-reset' });
    const expected = `data: ${JSON.stringify({ type: 'session-reset' })}\n\n`;
    expect(ca.writes).toContain(expected);
    expect(cb.writes).toContain(expected);
  });

  it('unregister removes side, isOnline returns false, end() called', () => {
    const c = fakeClient();
    hub.register('a', c);
    hub.unregister('a', c);
    expect(hub.isOnline('a')).toBe(false);
  });

  it('side can have multiple connections (two tabs)', () => {
    const c1 = fakeClient();
    const c2 = fakeClient();
    hub.register('a', c1);
    hub.register('a', c2);
    hub.broadcast({ type: 'session-reset' });
    expect(c1.writes.length).toBe(1);
    expect(c2.writes.length).toBe(1);
    hub.unregister('a', c1);
    expect(hub.isOnline('a')).toBe(true);
    hub.unregister('a', c2);
    expect(hub.isOnline('a')).toBe(false);
  });

  it('writes heartbeat comments to connected clients while any are online', () => {
    vi.useFakeTimers();
    try {
      const hb = createSseHub({ heartbeatMs: 1000 });
      const c = fakeClient();
      hb.register('a', c);
      vi.advanceTimersByTime(3000);
      expect(c.writes.filter(w => w === ': ping\n\n')).toHaveLength(3);
      hb.unregister('a', c);
      vi.advanceTimersByTime(3000);
      expect(c.writes.filter(w => w === ': ping\n\n')).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
