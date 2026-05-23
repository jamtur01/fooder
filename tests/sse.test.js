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

  it('onChange fires when a side first connects or last disconnects', () => {
    const events = [];
    hub.onChange((side, online) => events.push([side, online]));
    const c1 = fakeClient();
    const c2 = fakeClient();
    hub.register('a', c1);
    hub.register('a', c2);  // already online — no event
    hub.unregister('a', c1); // still online
    hub.unregister('a', c2); // now offline
    expect(events).toEqual([['a', true], ['a', false]]);
  });
});
