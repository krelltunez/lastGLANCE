// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import { WebSocket } from 'ws';
import { isLoopbackHost, startStreamDeckServer, type StreamDeckServer } from './streamDeckServer';
import { MAX_FRAME_BYTES, type DeckState } from './deckProtocol';

// The listener with real WebSocket clients: the trust model (a native client
// at once, a page only with a live token in time), the Host wall, every frame
// checked, every command answered, and state reaching trusted clients only.

const STATE: DeckState = { v: 1, type: 'lg:state', at: '2026-11-13T12:00:00.000Z', ready: true, counts: { overdue: 0, soon: 0 }, chores: [], due: [], reachOut: [], comingUp: [] };

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); });
  });
}

const servers: StreamDeckServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r())))); });

async function start(onCommand = vi.fn(() => ({ ok: true as const })), authTimeoutMs = 300) {
  const port = await freePort();
  const srv = startStreamDeckServer({ port, getState: () => STATE, onCommand, authTimeoutMs });
  servers.push(srv);
  await new Promise<void>((r) => srv.wss.once('listening', () => r()));
  return { port, srv, onCommand };
}

/** A client that records every message, and resolves `closed` when it is dropped. */
function client(port: number, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
  const messages: Record<string, unknown>[] = [];
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  const opened = new Promise<boolean>((r) => { ws.once('open', () => r(true)); ws.once('error', () => r(false)); });
  const closed = new Promise<number>((r) => ws.once('close', (code) => r(code)));
  const next = (type: string) => new Promise<Record<string, unknown>>((resolve) => {
    const found = messages.find((m) => m.type === type);
    if (found) { resolve(found); return; }
    ws.on('message', (d) => { const m = JSON.parse(String(d)); if (m.type === type) resolve(m); });
  });
  return { ws, messages, opened, closed, next };
}
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

describe('the Stream Deck listener', () => {
  it('trusts the plugin\'s backend at once: a token, then the state', async () => {
    const { port } = await start();
    const c = client(port);
    expect(await c.opened).toBe(true);
    const token = await c.next('lg:token');
    expect(token.token).toMatch(/^[0-9a-f]{32}$/);
    expect(await c.next('lg:state')).toEqual(STATE);
    c.ws.close();
  });

  it('lets a page in only with a live token as its first frame, in time', async () => {
    const { port } = await start();
    const backend = client(port);
    const { token } = await backend.next('lg:token');

    const page = client(port, { Origin: 'file://' });
    await page.opened;
    page.ws.send(JSON.stringify({ type: 'lg:auth', token }));
    expect(await page.next('lg:state')).toEqual(STATE);

    const wrong = client(port, { Origin: 'file://' });
    await wrong.opened;
    wrong.ws.send(JSON.stringify({ type: 'lg:auth', token: 'f'.repeat(32) }));
    await wrong.closed;
    expect(wrong.messages).toEqual([]);

    const silent = client(port, { Origin: 'https://evil.example' });
    await silent.opened;
    await silent.closed;   // dropped at the auth timeout
    expect(silent.messages).toEqual([]);

    // A token dies with the socket it was issued on.
    backend.ws.close();
    await backend.closed;
    await tick();
    const late = client(port, { Origin: 'file://' });
    await late.opened;
    late.ws.send(JSON.stringify({ type: 'lg:auth', token }));
    await late.closed;
    expect(late.messages).toEqual([]);
    page.ws.close();
  });

  it('refuses a Host that is not this machine', async () => {
    const { port } = await start();
    expect(await client(port, { Host: 'evil.example' }).opened).toBe(false);
    expect(isLoopbackHost('127.0.0.1:7901')).toBe(true);
    expect(isLoopbackHost('localhost:7901')).toBe(true);
    expect(isLoopbackHost('[::1]:7901')).toBe(true);
    expect(isLoopbackHost('127.0.0.1.evil.example')).toBe(false);
    expect(isLoopbackHost(undefined)).toBe(false);
  });

  it('applies only valid commands, and answers each by its clientId', async () => {
    const onCommand = vi.fn((cmd: { type: string }) => (cmd.type === 'lg:open' ? { ok: false as const, reason: 'refused' as const } : { ok: true as const }));
    const { port } = await start(onCommand);
    const c = client(port);
    await c.next('lg:state');
    c.ws.send('{oops');
    c.ws.send(JSON.stringify({ type: 'day:task:complete', id: 'x' }));
    c.ws.send(JSON.stringify({ type: 'lg:chore:complete', choreId: 'ch-1', clientId: 'k1' }));
    expect(await c.next('lg:result')).toEqual({ v: 1, type: 'lg:result', clientId: 'k1', ok: true });
    c.ws.send(JSON.stringify({ type: 'lg:open', target: 'action:delete', clientId: 'k2' }));
    await tick();
    expect(c.messages.filter((m) => m.type === 'lg:result')).toEqual([
      { v: 1, type: 'lg:result', clientId: 'k1', ok: true },
      { v: 1, type: 'lg:result', clientId: 'k2', ok: false, reason: 'refused' },
    ]);
    expect(onCommand.mock.calls.map(([cmd]) => cmd)).toEqual([
      { type: 'lg:chore:complete', choreId: 'ch-1', clientId: 'k1' },
      { type: 'lg:open', target: 'action:delete', clientId: 'k2' },
    ]);
    c.ws.close();
  });

  it('drops a client that sends a frame over the limit', async () => {
    const { port, onCommand } = await start();
    const c = client(port);
    await c.next('lg:state');
    c.ws.send('x'.repeat(MAX_FRAME_BYTES + 1));
    expect(await c.closed).toBe(1009);
    expect(onCommand).not.toHaveBeenCalled();
  });

  it('broadcasts to trusted clients only', async () => {
    const { port, srv } = await start(undefined, 2000);
    const trusted = client(port);
    await trusted.next('lg:state');
    const waiting = client(port, { Origin: 'file://' });
    await waiting.opened;
    srv.broadcast();
    await tick();
    expect(trusted.messages.filter((m) => m.type === 'lg:state')).toHaveLength(2);
    expect(waiting.messages).toEqual([]);
    expect(srv.clientCount()).toBe(1);
    trusted.ws.close();
    waiting.ws.close();
  });
});
