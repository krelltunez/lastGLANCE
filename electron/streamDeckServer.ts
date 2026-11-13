// The Stream Deck listener (docs/mcp-and-stream-deck.md, 6.1): a WebSocket
// server on 127.0.0.1:7901, started and stopped by the Settings switch. After
// dayGLANCE's electron/ws-server.ts, with three changes on purpose:
//  - every inbound frame is parsed against the protocol (deckProtocol.ts) and
//    anything else is dropped, never forwarded as it came;
//  - each command gets an answer (lg:result), so the plugin can show done or
//    "already done";
//  - a Host header other than this machine's loopback names is refused, on top
//    of the Origin rule, so a rebinding page has two walls to get through.
//
// Trust is dayGLANCE's model (deckProtocol.ts): no Origin is the plugin's Node
// backend, trusted at once and given a session token; a client with an Origin
// (a browser, the plugin's property inspector) must authenticate with a live
// token in its first frame within five seconds, or it is dropped. A token dies
// with the socket it was issued on.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  DECK_PROTOCOL_VERSION, MAX_FRAME_BYTES, MSG_AUTH, MSG_RESULT, MSG_TOKEN, parseDeckCommand,
  type DeckCommand, type DeckResultReason, type DeckState,
} from './deckProtocol.js';

export const AUTH_TIMEOUT_MS = 5000;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type DeckAction = Exclude<DeckCommand, { type: typeof MSG_AUTH }>;

export interface StreamDeckServerOptions {
  port: number;
  /** What the keys draw, built on demand (deckModel.ts). */
  getState: () => DeckState;
  /** Apply one command; the answer goes back to the client that sent it. */
  onCommand: (command: DeckAction) => { ok: true } | { ok: false; reason: DeckResultReason };
  authTimeoutMs?: number;
  log?: (msg: string) => void;
}

export interface StreamDeckServer {
  wss: WebSocketServer;
  /** Send the current state to every trusted client. */
  broadcast(): void;
  /** Trusted clients connected now. */
  clientCount(): number;
  close(onClosed?: () => void): void;
}

/** True when a Host header names this machine's loopback, on any port. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  return LOOPBACK_HOSTS.has(name.toLowerCase());
}

export function startStreamDeckServer(opts: StreamDeckServerOptions): StreamDeckServer {
  const log = opts.log ?? (() => {});
  const tokens = new Set<string>();
  const trusted = new Set<WebSocket>();
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: opts.port,
    maxPayload: MAX_FRAME_BYTES,
    verifyClient: ({ req }: { req: IncomingMessage }) => isLoopbackHost(req.headers.host),
  });

  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  const trust = (ws: WebSocket) => {
    trusted.add(ws);
    send(ws, opts.getState());
  };

  const handle = (ws: WebSocket, raw: unknown) => {
    const command = parseDeckCommand(raw);
    if (!command || command.type === MSG_AUTH) return;
    let answer: { ok: true } | { ok: false; reason: DeckResultReason };
    try {
      answer = opts.onCommand(command);
    } catch (err) {
      log(`stream deck command failed: ${err instanceof Error ? err.message : err}`);
      answer = { ok: false, reason: 'refused' };
    }
    send(ws, { v: DECK_PROTOCOL_VERSION, type: MSG_RESULT, clientId: command.clientId, ...answer });
  };

  wss.on('connection', (ws, req) => {
    ws.on('error', () => { /* a dropped client is not the app's problem */ });
    ws.on('close', () => trusted.delete(ws));
    if (!req.headers.origin) {
      // The plugin's Node backend: trusted, and handed a token for its property inspector.
      const token = randomBytes(16).toString('hex');
      tokens.add(token);
      ws.on('close', () => tokens.delete(token));
      send(ws, { v: DECK_PROTOCOL_VERSION, type: MSG_TOKEN, token });
      ws.on('message', (data) => handle(ws, data));
      trust(ws);
      return;
    }
    // A page: its first frame must be a live token, in time.
    const timer = setTimeout(() => ws.terminate(), opts.authTimeoutMs ?? AUTH_TIMEOUT_MS);
    ws.once('message', (data) => {
      clearTimeout(timer);
      const command = parseDeckCommand(data);
      if (command?.type !== MSG_AUTH || !tokens.has(command.token)) { ws.terminate(); return; }
      ws.on('message', (more) => handle(ws, more));
      trust(ws);
    });
    ws.on('close', () => clearTimeout(timer));
  });

  return {
    wss,
    broadcast() {
      if (trusted.size === 0) return;
      const state = JSON.stringify(opts.getState());
      for (const ws of trusted) if (ws.readyState === WebSocket.OPEN) ws.send(state);
    },
    clientCount: () => trusted.size,
    close(onClosed) {
      for (const ws of wss.clients) ws.terminate();
      wss.close(() => onClosed?.());
    },
  };
}
