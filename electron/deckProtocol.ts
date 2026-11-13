// The Stream Deck wire protocol (docs/mcp-and-stream-deck.md, 6.2), version 1:
// what the app's listener (streamDeckServer.ts) sends and accepts. The plugin
// (stream-deck-plugin/, phase 6) imports this file, so it stays free of Node
// and Electron: plain types, constants and the parser.
//
// Out, app to plugin:
//   lg:state   everything the keys draw (DeckState), on connect and on change
//   lg:token   a session token for the plugin's property inspector (below)
//   lg:result  the answer to one command, by its clientId
// In, plugin to app:
//   lg:auth            a page (Origin) proves it holds a token, first frame
//   lg:chore:complete  mark one chore done
//   lg:open            show the app, at a token it can open
//
// Trust (dayGLANCE's model, kept on purpose): a client without an Origin is a
// native process, the plugin's Node backend, and is trusted at once; it gets a
// token. A client with an Origin (a browser, the plugin's property inspector)
// must send lg:auth with a live token as its first frame within five seconds,
// or it is dropped. That keeps a web page from driving the socket.

export const DECK_PROTOCOL_VERSION = 1;
export const STREAM_DECK_PORT = 7901;

export const MSG_STATE = 'lg:state';
export const MSG_TOKEN = 'lg:token';
export const MSG_RESULT = 'lg:result';
export const MSG_AUTH = 'lg:auth';
export const MSG_COMPLETE = 'lg:chore:complete';
export const MSG_OPEN = 'lg:open';

/** A frame larger than this is refused by the listener. */
export const MAX_FRAME_BYTES = 16 * 1024;

export type DeckChoreState = 'overdue' | 'soon' | 'fresh' | 'none';

export interface DeckChore {
  id: string;
  name: string;
  /** A Lucide icon name, as the app stores it; null for none. */
  icon: string | null;
  category: string | null;
  state: DeckChoreState;
  /** Elapsed over cadence, unclamped (1 = due); null with no cadence or never done. */
  ratio: number | null;
  /** The cadence colour the app draws, green through amber to red; null with no ratio. */
  color: string | null;
  lastCompletedAt: string | null;
  cadenceDays: number | null;
  pinned: boolean;
  /** Marked done from here (the deck or the tray) and not yet reflected by the app. */
  justDone: boolean;
}

export interface DeckPerson {
  id: string;
  name: string;
  ratio: number | null;
  color: string;
  /** Why they are on Reach out, or when they were last in touch, in the app's language. */
  detail: string;
}

export interface DeckDate {
  personId: string;
  name: string;
  /** "Birthday (40)", or the custom label, in the app's language. */
  label: string;
  /** The local day it falls on, YYYY-MM-DD. */
  on: string;
}

export interface DeckState {
  v: typeof DECK_PROTOCOL_VERSION;
  type: typeof MSG_STATE;
  /** When this state was built (ISO). */
  at: string;
  /** False until the app has sent its first snapshot: the keys say "open lastGLANCE", not "nothing due". */
  ready: boolean;
  counts: { overdue: number; soon: number };
  /** Every chore, for the Chore key's picker and the Due key. */
  chores: DeckChore[];
  /** The ids of the chores that need doing, most overdue first. */
  due: string[];
  reachOut: DeckPerson[];
  comingUp: DeckDate[];
}

export interface DeckTokenMessage { v: typeof DECK_PROTOCOL_VERSION; type: typeof MSG_TOKEN; token: string }

export type DeckResultReason = 'unknown_chore' | 'too_soon' | 'invalid' | 'refused';
export interface DeckResult { v: typeof DECK_PROTOCOL_VERSION; type: typeof MSG_RESULT; clientId: string; ok: boolean; reason?: DeckResultReason }

export type DeckCommand =
  | { type: typeof MSG_AUTH; token: string }
  | { type: typeof MSG_COMPLETE; choreId: string; clientId: string }
  | { type: typeof MSG_OPEN; target: string | null; clientId: string };

const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * One inbound frame as a command, or null for anything else: unparseable, too
 * large, a type outside the protocol, or fields of the wrong shape. Nothing is
 * forwarded unchecked (dayGLANCE's listener forwarded every frame as it came).
 */
export function parseDeckCommand(raw: unknown): DeckCommand | null {
  let text: string;
  if (typeof raw === 'string') text = raw;
  else if (raw instanceof Uint8Array) text = new TextDecoder().decode(raw);
  else return null;
  if (text.length > MAX_FRAME_BYTES) return null;
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    msg = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const clientId = typeof msg.clientId === 'string' && ID_RE.test(msg.clientId) ? msg.clientId : null;
  switch (msg.type) {
    case MSG_AUTH:
      return typeof msg.token === 'string' && /^[0-9a-f]{32}$/.test(msg.token) ? { type: MSG_AUTH, token: msg.token } : null;
    case MSG_COMPLETE:
      return typeof msg.choreId === 'string' && ID_RE.test(msg.choreId) && clientId ? { type: MSG_COMPLETE, choreId: msg.choreId, clientId } : null;
    case MSG_OPEN:
      if (!clientId) return null;
      if (msg.target === null || msg.target === undefined) return { type: MSG_OPEN, target: null, clientId };
      return typeof msg.target === 'string' && msg.target.length <= 200 ? { type: MSG_OPEN, target: msg.target, clientId } : null;
    default:
      return null;
  }
}
