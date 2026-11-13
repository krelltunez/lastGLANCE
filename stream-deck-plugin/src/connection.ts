// The plugin's connection to the lastGLANCE desktop app (docs/mcp-and-stream-deck.md,
// 6.2): one WebSocket to ws://127.0.0.1:7901, reconnecting with backoff while
// the app is closed or Stream Deck is off in its Settings. Pure apart from the
// socket and timer it is handed, so it is tested without Stream Deck or a
// network.
//
// It connects with no Origin, as a native client, which the app trusts at once
// (electron/streamDeckServer.ts). The session token the app also sends is for
// a property inspector that opens its own socket; this plugin's inspectors
// talk to the backend over Stream Deck's own channel instead, so it is unused.

import {
  DECK_PROTOCOL_VERSION, MSG_COMPLETE, MSG_OPEN, MSG_RESULT, MSG_STATE, STREAM_DECK_PORT,
  type DeckResult, type DeckState,
} from '../../electron/deckProtocol';

export const DECK_URL = `ws://127.0.0.1:${STREAM_DECK_PORT}`;
export const RETRY_MIN_MS = 1000;
export const RETRY_MAX_MS = 30_000;
export const RESULT_TIMEOUT_MS = 5000;

/** The part of a ws WebSocket this uses. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'close' | 'error', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
}

export interface ConnectionDeps {
  open: (url: string) => SocketLike;
  /** The app's listener; tests point it at a free port. */
  url?: string;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (msg: string) => void;
}

/** What a command came back with: the app's answer, or null when it could not be asked (not connected, no answer). */
export type CommandOutcome = Pick<DeckResult, 'ok' | 'reason'> | null;

const OPEN = 1;

export function isDeckState(v: unknown): v is DeckState {
  const s = v as Partial<DeckState> | null;
  return !!s && s.type === MSG_STATE && s.v === DECK_PROTOCOL_VERSION && Array.isArray(s.chores) && Array.isArray(s.due)
    && Array.isArray(s.reachOut) && Array.isArray(s.comingUp) && !!s.counts;
}

export function createConnection(deps: ConnectionDeps) {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const log = deps.log ?? (() => {});
  const listeners = new Set<(state: DeckState | null) => void>();
  const pending = new Map<string, { resolve: (o: CommandOutcome) => void; timer: unknown }>();
  let socket: SocketLike | null = null;
  let state: DeckState | null = null;
  let retryMs = RETRY_MIN_MS;
  let retryTimer: unknown = null;
  let stopped = true;
  let seq = 0;

  const emit = () => { for (const l of listeners) l(state); };

  const settleAll = () => {
    for (const [id, p] of pending) { clearTimer(p.timer); p.resolve(null); pending.delete(id); }
  };

  const connect = () => {
    retryTimer = null;
    if (stopped) return;
    let ws: SocketLike;
    try {
      ws = deps.open(deps.url ?? DECK_URL);
    } catch {
      scheduleRetry();
      return;
    }
    socket = ws;
    ws.on('open', () => {
      retryMs = RETRY_MIN_MS;
      log('connected to lastGLANCE');
    });
    ws.on('message', (data) => {
      let msg: unknown;
      try { msg = JSON.parse(String(data)); } catch { return; }
      if (isDeckState(msg)) {
        state = msg;
        emit();
        return;
      }
      const r = msg as Partial<DeckResult> | null;
      if (r?.type === MSG_RESULT && typeof r.clientId === 'string') {
        const p = pending.get(r.clientId);
        if (!p) return;
        pending.delete(r.clientId);
        clearTimer(p.timer);
        p.resolve({ ok: r.ok === true, ...(r.reason && { reason: r.reason }) });
      }
    });
    ws.on('error', () => { /* 'close' follows */ });
    ws.on('close', () => {
      if (socket !== ws) return;
      socket = null;
      // Not connected is not "nothing due": the keys say the app is not running.
      if (state !== null) { state = null; emit(); }
      settleAll();
      scheduleRetry();
    });
  };

  const scheduleRetry = () => {
    if (stopped || retryTimer !== null) return;
    const wait = retryMs;
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
    retryTimer = setTimer(connect, wait);
  };

  const command = (payload: Record<string, unknown>): Promise<CommandOutcome> => {
    const ws = socket;
    if (!ws || ws.readyState !== OPEN) return Promise.resolve(null);
    const clientId = `sd-${Date.now().toString(36)}-${++seq}`;
    return new Promise((resolve) => {
      const timer = setTimer(() => { pending.delete(clientId); resolve(null); }, RESULT_TIMEOUT_MS);
      pending.set(clientId, { resolve, timer });
      ws.send(JSON.stringify({ v: DECK_PROTOCOL_VERSION, ...payload, clientId }));
    });
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      connect();
    },
    stop() {
      stopped = true;
      if (retryTimer !== null) { clearTimer(retryTimer); retryTimer = null; }
      const ws = socket;
      socket = null;
      ws?.close();
      settleAll();
    },
    /** Called now with the current state (null when not connected), then on every change. Returns the unsubscribe. */
    onState(listener: (state: DeckState | null) => void): () => void {
      listeners.add(listener);
      listener(state);
      return () => { listeners.delete(listener); };
    },
    state: () => state,
    /** Mark a chore done. */
    complete: (choreId: string) => command({ type: MSG_COMPLETE, choreId }),
    /** Show the app, at a token it can open (null: just the app). */
    openApp: (target: string | null) => command({ type: MSG_OPEN, target }),
  };
}

export type Connection = ReturnType<typeof createConnection>;
