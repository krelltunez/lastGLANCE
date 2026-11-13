import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRendererBridge, PING_TIMEOUT_MS, REQUEST_TIMEOUT_MS, UNAVAILABLE, type BridgeIpc } from './mcpRendererBridge';

vi.mock('electron', () => ({ ipcMain: {} }));

type Listener = (event: { sender: unknown }, raw: unknown) => void;

/** A main window whose page answers what the test tells it to, and a fake ipcMain. */
function setup() {
  const listeners = new Set<Listener>();
  const ipc: BridgeIpc = { on: (_c, l) => { listeners.add(l); }, removeListener: (_c, l) => { listeners.delete(l); } };
  const sent: { id: number; method: string; params: unknown }[] = [];
  const mainContents = { send: vi.fn((_channel: string, req: { id: number; method: string; params: unknown }) => { sent.push(req); }) };
  let window: { webContents: typeof mainContents } | null = { webContents: mainContents };
  const bridge = createRendererBridge(() => window as never, ipc);
  const reply = (raw: unknown, sender: unknown = mainContents) => { for (const l of listeners) l({ sender }, raw); };
  return { bridge, sent, reply, listeners, mainContents, closeWindow: () => { window = null; } };
}

afterEach(() => { vi.useRealTimers(); });

describe('the MCP request bridge', () => {
  it('sends a request to the main window and resolves with its answer', async () => {
    const s = setup();
    const pending = s.bridge.request('overview', { include_people: false });
    expect(s.sent).toEqual([{ id: 1, method: 'overview', params: { include_people: false } }]);
    s.reply({ id: 1, ok: true, data: { counts: {} } });
    await expect(pending).resolves.toEqual({ ok: true, data: { counts: {} } });
  });

  it('passes a typed error through, and names an untyped one internal', async () => {
    const s = setup();
    const a = s.bridge.request('get_chore');
    s.reply({ id: 1, ok: false, error: { code: 'not_found', message: 'No chore' } });
    await expect(a).resolves.toEqual({ ok: false, error: { code: 'not_found', message: 'No chore' } });
    const b = s.bridge.request('get_chore');
    s.reply({ id: 2, ok: false });
    await expect(b).resolves.toMatchObject({ ok: false, error: { code: 'internal' } });
  });

  it('takes answers from the main window only, so the tray popup can never answer', async () => {
    vi.useFakeTimers();
    const s = setup();
    const pending = s.bridge.request('overview');
    s.reply({ id: 1, ok: true, data: { from: 'the tray' } }, { send: () => {} });
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await expect(pending).resolves.toEqual(UNAVAILABLE);
  });

  it('is unavailable, never empty, with no window, a send that throws, or no answer in time', async () => {
    vi.useFakeTimers();
    const s = setup();
    const late = s.bridge.request('overview');
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await expect(late).resolves.toEqual(UNAVAILABLE);
    s.reply({ id: 1, ok: true, data: {} }); // the late answer is dropped
    expect(UNAVAILABLE).toMatchObject({ ok: false, error: { code: 'renderer_unavailable', message: expect.stringContaining('NOT an empty list') } });

    s.mainContents.send.mockImplementationOnce(() => { throw new Error('destroyed'); });
    await expect(s.bridge.request('overview')).resolves.toEqual(UNAVAILABLE);

    s.closeWindow();
    await expect(s.bridge.request('overview')).resolves.toEqual(UNAVAILABLE);
  });

  it('pings with the short timeout, and answers everything pending on dispose', async () => {
    vi.useFakeTimers();
    const s = setup();
    const ping = s.bridge.ping();
    vi.advanceTimersByTime(PING_TIMEOUT_MS);
    await expect(ping).resolves.toBe(false);
    const pending = s.bridge.request('overview');
    s.bridge.dispose();
    await expect(pending).resolves.toEqual(UNAVAILABLE);
    expect(s.listeners.size).toBe(0);
  });
});
