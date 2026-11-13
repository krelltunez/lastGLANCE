// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import WebSocket from 'ws';
import { createConnection, type SocketLike } from './connection';
import { choreKey, dueKey } from './keys';
import { startStreamDeckServer, type StreamDeckServer } from '../../electron/streamDeckServer';
import { deckState } from '../../electron/deckModel';
import type { TraySnapshot } from '../../electron/trayModel';

// The two halves together: the plugin's real connection against the app's
// real listener and deck model, over a real socket. The protocol module is
// shared, but only this shows the plugin is let in, gets the state the keys
// draw, and has its press reach the app and come back answered.

const NOW = Date.now();
const snapshot: TraySnapshot = {
  generatedAt: NOW,
  chores: [{ syncId: 'ch-water', name: 'Water plants', icon: 'Sprout', categoryName: 'Garden', state: 'overdue', lastCompletedAt: new Date(NOW - 9 * 86_400_000).toISOString(), elapsedDays: 9, targetCadenceDays: 7, ratio: 1.29, color: '#ef4444', pinned: false }],
  reachOut: [],
  comingUp: [],
};

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); });
  });
}

let server: StreamDeckServer | null = null;
afterEach(async () => { await new Promise<void>((r) => (server ? server.close(() => r()) : r())); server = null; });

describe('the plugin and the app together', () => {
  it('connects, draws the app\'s chores, and a press comes back answered once', async () => {
    const port = await freePort();
    const doneHere = new Map<string, number>();
    const onCommand = vi.fn((cmd: { type: string; choreId?: string }) => {
      if (cmd.type !== 'lg:chore:complete') return { ok: true as const };
      if (doneHere.has(cmd.choreId!)) return { ok: false as const, reason: 'too_soon' as const };
      doneHere.set(cmd.choreId!, Date.now());
      server!.broadcast();
      return { ok: true as const };
    });
    server = startStreamDeckServer({ port, getState: () => deckState(snapshot, doneHere, Date.now()), onCommand });
    await new Promise<void>((r) => server!.wss.once('listening', () => r()));

    const conn = createConnection({ url: `ws://127.0.0.1:${port}`, open: (url) => new WebSocket(url) as unknown as SocketLike });
    const states: unknown[] = [];
    conn.onState((s) => states.push(s));
    conn.start();
    await vi.waitFor(() => expect(conn.state()?.ready).toBe(true));

    expect(dueKey(conn.state(), 0, Date.now())).toMatchObject({ choreId: 'ch-water', view: { title: 'Water plants', icon: 'Sprout' } });
    await expect(conn.complete('ch-water')).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(choreKey(conn.state(), 'ch-water', Date.now()).view.sub).toBe('Done'));
    await expect(conn.complete('ch-water')).resolves.toEqual({ ok: false, reason: 'too_soon' });
    await expect(conn.openApp('action:add')).resolves.toEqual({ ok: true });
    expect(onCommand.mock.calls.map(([c]) => c.type)).toEqual(['lg:chore:complete', 'lg:chore:complete', 'lg:open']);

    // The app going away reads as not running on every key.
    server.close();
    server = null;
    await vi.waitFor(() => expect(conn.state()).toBeNull());
    conn.stop();
  });
});
