// The MCP request bridge, main's half (docs/mcp-and-stream-deck.md, 4.2): the
// tools ask the main window's page, which answers from the database
// (src/mcp/useMcpBridge.ts). After dayGLANCE's electron/mcpRendererBridge.ts.
//
// `request` never rejects and never hangs. No window, a send that throws, or
// no answer in time all resolve to `renderer_unavailable`, whose message says
// plainly that this is not an empty list: an empty answer would read as "no
// chores", and the model would report it with confidence.
//
// Only the main window answers. A reply from any other page (the tray popup)
// is dropped, and the request times out to unavailable.

import { ipcMain, type BrowserWindow } from 'electron';
import type { BridgeResult, HostBridge } from '@glance-apps/mcp-host';

/** The health check: far above a live page's reply time. */
export const PING_TIMEOUT_MS = 1000;
/** A data request: the page reads the database before it answers. */
export const REQUEST_TIMEOUT_MS = 3000;
/** Completion history across every chore. */
export const HISTORY_TIMEOUT_MS = 8000;

export const UNAVAILABLE: BridgeResult = {
  ok: false,
  error: {
    code: 'renderer_unavailable',
    message:
      'The lastGLANCE window is not responding (it may be starting, restarting or closed). ' +
      'The data is temporarily unreadable. This is NOT an empty list. Retry shortly.',
  },
};

/** The IPC surface the bridge uses, so a test can drive it without Electron. */
export interface BridgeIpc {
  on(channel: 'mcp:response', listener: (event: { sender: unknown }, raw: unknown) => void): void;
  removeListener(channel: 'mcp:response', listener: (event: { sender: unknown }, raw: unknown) => void): void;
}

/**
 * A getter, never a captured window: crash recovery can recreate the main
 * window, and a request must go to the current one.
 */
export function createRendererBridge(
  getMainWindow: () => Pick<BrowserWindow, 'webContents'> | null,
  ipc: BridgeIpc = ipcMain as unknown as BridgeIpc,
): HostBridge {
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: BridgeResult) => void; timer: ReturnType<typeof setTimeout> }>();

  const onResponse = (event: { sender: unknown }, raw: unknown): void => {
    const mw = getMainWindow();
    if (!mw || event.sender !== mw.webContents) return;
    const response = raw as { id?: unknown; ok?: unknown; data?: unknown; undo?: unknown; error?: unknown } | null;
    if (typeof response?.id !== 'number') return;
    const entry = pending.get(response.id);
    if (!entry) return; // a late answer, already reported unavailable
    pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.ok === true) {
      // `undo` is the write journal's descriptor (phase 3): main's own, never tool output.
      entry.resolve({ ok: true, data: response.data, ...(response.undo !== undefined ? { undo: response.undo } : {}) });
      return;
    }
    const err = (response.error ?? {}) as { code?: unknown; message?: unknown };
    entry.resolve({
      ok: false,
      error: {
        code: typeof err.code === 'string' ? err.code : 'internal',
        message: typeof err.message === 'string' ? err.message : 'lastGLANCE reported an error.',
      },
    });
  };
  ipc.on('mcp:response', onResponse);

  const request = (method: string, params: unknown = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<BridgeResult> => {
    const mw = getMainWindow();
    if (!mw) return Promise.resolve(UNAVAILABLE);
    return new Promise((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(UNAVAILABLE);
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      try {
        mw.webContents.send('mcp:request', { id, method, params });
      } catch {
        // A destroyed webContents throws: the same answer.
        pending.delete(id);
        clearTimeout(timer);
        resolve(UNAVAILABLE);
      }
    });
  };

  return {
    request,
    ping: async () => (await request('ping', {}, PING_TIMEOUT_MS)).ok,
    dispose: () => {
      ipc.removeListener('mcp:response', onResponse);
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.resolve(UNAVAILABLE);
        pending.delete(id);
      }
    },
  };
}
