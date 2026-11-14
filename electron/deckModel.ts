// What the Stream Deck shows (docs/mcp-and-stream-deck.md, 6.1), as a pure
// function of the widget snapshot the tray already holds (trayModel.ts), the
// completions made here that the app has not reflected yet, and the clock.
// No new push from the page: the deck reads what the tray reads.
//
// The clock matters because the snapshot is only rebuilt when the data
// changes: a chore last done three days ago must read three days and a minute
// a minute later, with the window closed. So each chore's ratio, state and
// colour are recomputed from its last completion and cadence, by the app's own
// thresholds (src/utils/cadence.ts: soon at 75%, overdue at 100%, the colour
// green to amber to red at twice the cadence).
//
// The guard below keeps one chore from being marked done twice from here in a
// minute: a press only ever completes (never toggles, unlike dayGLANCE's deck),
// and a second press, or a press just after the tray's, is answered too_soon.

import { trayOpenToken, type TraySnapshot } from './trayModel.js';
import { DECK_PROTOCOL_VERSION, MSG_STATE, type DeckChore, type DeckChoreState, type DeckNextDue, type DeckSince, type DeckState } from './deckProtocol.js';

const DAY_MS = 86_400_000;
export const ATTENTION_RATIO = 0.75;
export const DECK_COMPLETE_WINDOW_MS = 60_000;

const round2 = (n: number) => Math.round(n * 100) / 100;

function hex(c: string): [number, number, number] {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hex(a);
  const [br, bg, bb] = hex(b);
  const ch = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${ch(ar, br)}${ch(ag, bg)}${ch(ab, bb)}`;
}

/** The app's cadence colour (src/utils/cadence.ts, getCadenceColor): green to amber within cadence, amber to red at twice it. */
export function cadenceColor(ratio: number): string {
  if (ratio < 1) return mix('#22c55e', '#f59e0b', Math.max(0, ratio));
  return mix('#f59e0b', '#ef4444', Math.min(ratio - 1, 1));
}

export function stateFor(ratio: number | null): DeckChoreState {
  if (ratio === null) return 'none';
  if (ratio >= 1) return 'overdue';
  if (ratio >= ATTENTION_RATIO) return 'soon';
  return 'fresh';
}

// ── The app's words for time (src/utils/cadence.ts) ────────────────────────
// The app's chore list says "2 days ago" by calendar days in the user's zone,
// and a key that counted 24-hour periods said "1d" for the same chore. These
// follow formatElapsed and formatNextDue step by step, in this process's zone
// (the user's: main runs on their machine), and deckModel.test.ts runs both
// over the same instants to hold them equal.

/** Local midnight of an instant's day. */
const dayStart = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
/** Whole calendar days from one instant's day to another's (DST days are 23 or 25 hours). */
const calendarDays = (from: number, to: number) => Math.round((dayStart(to) - dayStart(from)) / DAY_MS);
/** The app's elapsed_days (src/db/queries.ts): whole minutes over a day, to a tenth. */
export function elapsedDays(lastMs: number, now: number): number {
  return Math.round((Math.trunc((now - lastMs) / 60_000) / 1440) * 10) / 10;
}

/** formatElapsed's choice, as data. */
export function sinceOf(last: string | null, now: number): DeckSince {
  const lastMs = last ? Date.parse(last) : NaN;
  if (!Number.isFinite(lastMs)) return { kind: 'never' };
  const minutes = Math.trunc((now - lastMs) / 60_000);
  if (minutes < 1) return { kind: 'just_now' };
  if (minutes < 60) return { kind: 'minutes', count: minutes };
  if (elapsedDays(lastMs, now) < 1) return { kind: 'hours', count: Math.floor(minutes / 60) };
  const days = calendarDays(lastMs, now);
  return days === 1 ? { kind: 'yesterday' } : { kind: 'days', count: days };
}

/** formatNextDue's choice, as data. */
export function nextDueOf(last: string | null, cadence: number | null, now: number): DeckNextDue {
  const lastMs = last ? Date.parse(last) : NaN;
  if (!Number.isFinite(lastMs) || cadence === null) return { kind: 'none' };
  // isPastCadence: a cadence of 0 never qualifies, and is no cadence there.
  if (cadence && elapsedDays(lastMs, now) >= cadence) return { kind: 'now' };
  const dueAt = new Date(lastMs);
  dueAt.setDate(dueAt.getDate() + cadence);
  const until = calendarDays(now, dueAt.getTime());
  if (until === 0) return { kind: 'today' };
  if (until === 1) return { kind: 'tomorrow' };
  return { kind: 'days', count: until };
}

/** One chore, aged to `now`; done just now when it was completed here and the app has not caught up. */
function deckChore(c: TraySnapshot['chores'][number], doneAt: number | undefined, now: number): DeckChore {
  const cadence = c.targetCadenceDays;
  const last = doneAt !== undefined ? new Date(doneAt).toISOString() : c.lastCompletedAt;
  const lastMs = last ? Date.parse(last) : NaN;
  const ratio = cadence && cadence > 0 && Number.isFinite(lastMs) ? round2(Math.max(0, now - lastMs) / DAY_MS / cadence) : null;
  return {
    id: c.syncId,
    name: c.name,
    icon: c.icon,
    category: c.categoryName,
    state: stateFor(ratio),
    ratio,
    color: ratio === null ? null : cadenceColor(ratio),
    lastCompletedAt: last,
    cadenceDays: cadence,
    pinned: c.pinned,
    since: sinceOf(last, now),
    nextDue: nextDueOf(last, cadence, now),
    justDone: doneAt !== undefined,
  };
}

/** The deck's state: every chore aged to `now`, the due ones most overdue first, and People as the snapshot words them. */
export function deckState(snapshot: TraySnapshot | null, doneHere: ReadonlyMap<string, number>, now: number): DeckState {
  const chores = (snapshot?.chores ?? []).map((c) => deckChore(c, doneHere.get(c.syncId), now));
  const due = chores
    .filter((c) => c.state === 'overdue' || c.state === 'soon')
    .sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0) || a.name.localeCompare(b.name));
  return {
    v: DECK_PROTOCOL_VERSION,
    type: MSG_STATE,
    at: new Date(now).toISOString(),
    ready: snapshot !== null,
    counts: { overdue: due.filter((c) => c.state === 'overdue').length, soon: due.filter((c) => c.state === 'soon').length },
    chores,
    due: due.map((c) => c.id),
    // The app's Pinned row (src/utils/pinned.ts): most overdue first, chores without a ratio last, then by name.
    pinned: chores
      .filter((c) => c.pinned)
      .sort((a, b) => (a.ratio === b.ratio ? a.name.localeCompare(b.name) : a.ratio === null ? 1 : b.ratio === null ? -1 : b.ratio - a.ratio))
      .map((c) => c.id),
    reachOut: (snapshot?.reachOut ?? []).map((p) => ({ id: p.syncId, name: p.name, ratio: p.ratio, color: p.color, detail: p.detail })),
    comingUp: (snapshot?.comingUp ?? []).map((d) => ({ personId: d.personSyncId, name: d.name, label: d.label, on: d.on })),
  };
}

/**
 * Whether a press may mark this chore done: it must be in the snapshot, and
 * not done in the last minute. Three records count, since none alone holds for
 * the whole minute:
 *  - `pressed`, the deck's own presses, kept the full minute whatever happens;
 *  - `doneHere`, completions made here (the deck or the tray), which the app
 *    settles once a snapshot built after them arrives (settledCompletions). A
 *    snapshot can be built after a press yet from data read before the press
 *    was applied, so settling alone can forget a press too early;
 *  - the snapshot's last completion, for one made anywhere else (the app, a
 *    phone through sync).
 */
export function deckCompletion(
  choreId: string,
  snapshot: TraySnapshot | null,
  doneHere: ReadonlyMap<string, number>,
  now: number,
  pressed: ReadonlyMap<string, number> = new Map(),
  windowMs = DECK_COMPLETE_WINDOW_MS,
): 'ok' | 'unknown_chore' | 'too_soon' {
  const chore = snapshot?.chores.find((c) => c.syncId === choreId);
  if (!chore) return 'unknown_chore';
  const recent = (at: number | undefined) => at !== undefined && Number.isFinite(at) && now - at >= 0 && now - at < windowMs;
  const last = chore.lastCompletedAt ? Date.parse(chore.lastCompletedAt) : undefined;
  return recent(pressed.get(choreId)) || recent(doneHere.get(choreId)) || recent(last) ? 'too_soon' : 'ok';
}

/** The presses still inside the window, so the record stays small. */
export function prunePresses(pressed: Map<string, number>, now: number, windowMs = DECK_COMPLETE_WINDOW_MS): void {
  for (const [id, at] of pressed) if (now - at >= windowMs || now < at) pressed.delete(id);
}

/**
 * What a key may open: just the app (null), Add chore, the Soon filter, or a
 * chore or person the snapshot holds (the tray's rule, trayOpenToken). False
 * for anything else, which is refused rather than guessed.
 */
export function deckOpenToken(target: string | null, snapshot: TraySnapshot | null): string | null | false {
  if (target === null) return null;
  if (target === 'action:add' || target === 'filter:soon') return target;
  return trayOpenToken(target, snapshot) ?? false;
}
