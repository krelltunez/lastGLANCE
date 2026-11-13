import { describe, expect, it } from 'vitest';
import { createConnection, DECK_URL, RESULT_TIMEOUT_MS, RETRY_MAX_MS, type SocketLike } from './connection';
import type { DeckState } from '../../electron/deckProtocol';

// The plugin's connection with a fake socket and a hand-driven clock: what the
// keys hear when the app comes and goes, the backoff, and commands answered,
// unanswered or impossible.

const STATE: DeckState = { v: 1, type: 'lg:state', at: '2026-11-13T12:00:00.000Z', ready: true, counts: { overdue: 1, soon: 0 }, chores: [], due: [], reachOut: [], comingUp: [] };

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  private handlers = new Map<string, ((data?: unknown) => void)[]>();
  on(event: string, listener: (data?: unknown) => void) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]); return this; }
  emit(event: string, data?: unknown) { for (const h of this.handlers.get(event) ?? []) h(data); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  open() { this.readyState = 1; this.emit('open'); }
  drop() { this.readyState = 3; this.emit('close'); }
  receive(msg: unknown) { this.emit('message', Buffer.from(JSON.stringify(msg))); }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let nextId = 0;
  const conn = createConnection({
    open: (url) => { urls.push(url); const s = new FakeSocket(); sockets.push(s); return s; },
    setTimer: (fn, ms) => { const id = ++nextId; timers.push({ fn, ms, id }); return id; },
    clearTimer: (h) => { const i = timers.findIndex((t) => t.id === h); if (i >= 0) timers.splice(i, 1); },
  });
  const fire = (ms?: number) => { const t = ms === undefined ? timers.shift() : timers.splice(timers.findIndex((x) => x.ms === ms), 1)[0]; t?.fn(); return t?.ms; };
  return { conn, sockets, urls, timers, fire };
}

describe('the connection to lastGLANCE', () => {
  it('connects to the app on this computer, and hands the keys each state', () => {
    const { conn, sockets, urls } = setup();
    const seen: (DeckState | null)[] = [];
    conn.onState((s) => seen.push(s));
    conn.start();
    expect(urls).toEqual([DECK_URL]);
    expect(DECK_URL).toBe('ws://127.0.0.1:7901');
    sockets[0].open();
    sockets[0].receive(STATE);
    sockets[0].receive({ type: 'lg:state', v: 2 });        // another version: ignored
    sockets[0].receive({ type: 'lg:token', token: 'x' });  // not for the keys
    expect(seen).toEqual([null, STATE]);
    expect(conn.state()).toEqual(STATE);
  });

  it('tells the keys when the app goes, and retries with backoff, reset once connected', () => {
    const { conn, sockets, fire } = setup();
    const seen: (DeckState | null)[] = [];
    conn.onState((s) => seen.push(s));
    conn.start();
    sockets[0].open();
    sockets[0].receive(STATE);
    sockets[0].drop();
    expect(seen.at(-1)).toBeNull();                        // not running, never "nothing due"
    const waits: number[] = [];
    for (let i = 1; i <= 7; i++) { waits.push(fire()!); sockets[i].drop(); }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, RETRY_MAX_MS, RETRY_MAX_MS]);
    fire();
    sockets[8].open();
    sockets[8].drop();
    expect(fire()).toBe(1000);
  });

  it('sends a command with its own id, and resolves with the app\'s answer', async () => {
    const { conn, sockets } = setup();
    conn.start();
    sockets[0].open();
    const pending = conn.complete('ch-water');
    const sent = sockets[0].sent[0];
    expect(sent).toMatchObject({ v: 1, type: 'lg:chore:complete', choreId: 'ch-water' });
    expect(sent.clientId).toMatch(/^[A-Za-z0-9_.:-]{1,128}$/);
    sockets[0].receive({ v: 1, type: 'lg:result', clientId: sent.clientId, ok: false, reason: 'too_soon' });
    await expect(pending).resolves.toEqual({ ok: false, reason: 'too_soon' });
    const opening = conn.openApp('action:add');
    expect(sockets[0].sent[1]).toMatchObject({ type: 'lg:open', target: 'action:add' });
    sockets[0].receive({ v: 1, type: 'lg:result', clientId: sockets[0].sent[1].clientId, ok: true });
    await expect(opening).resolves.toEqual({ ok: true });
  });

  it('answers null when the app cannot be asked: not connected, no answer in time, or gone mid-wait', async () => {
    const { conn, sockets, fire } = setup();
    conn.start();
    await expect(conn.complete('ch-1')).resolves.toBeNull();     // still connecting
    sockets[0].open();
    const silent = conn.complete('ch-1');
    expect(fire(RESULT_TIMEOUT_MS)).toBe(RESULT_TIMEOUT_MS);
    await expect(silent).resolves.toBeNull();
    const dropped = conn.complete('ch-1');
    sockets[0].drop();
    await expect(dropped).resolves.toBeNull();
  });

  it('stops for good: closes the socket and never retries', () => {
    const { conn, sockets, timers } = setup();
    conn.start();
    sockets[0].open();
    conn.stop();
    expect(sockets[0].closed).toBe(true);
    sockets[0].drop();
    expect(timers).toEqual([]);
  });
});
