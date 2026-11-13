// What each key shows (docs/mcp-and-stream-deck.md, 6.3), as pure functions of
// the app's state (DeckState, electron/deckModel.ts) and the clock. The actions
// draw these with render.ts and act on the ids they return; nothing here
// touches Stream Deck.
//
// Not connected (state null) and connected but not ready (the app has not sent
// its first snapshot) each read as what they are, never as "nothing due".

import type { DeckChore, DeckState } from '../../electron/deckProtocol';

export interface KeyView {
  /** The main line: a chore or person's name, or a big number. */
  title: string;
  sub?: string;
  /** A Lucide icon name, as the app stores it. */
  icon?: string | null;
  /** The accent: the cadence colour, or a fixed one. */
  accent: string;
  /** The fill bar along the bottom, 0..1 and beyond (clamped when drawn); none when null. */
  ratio?: number | null;
  /** Greyed: nothing to act on. */
  dim?: boolean;
  /** The title is a number, drawn large. */
  big?: boolean;
}

export const GREY = '#64748b';
export const GREEN = '#22c55e';
export const AMBER = '#f59e0b';
export const RED = '#ef4444';
export const PINK = '#f472b6';
export const BLUE = '#38bdf8';

const DAY = 86_400_000;

export const OFFLINE: KeyView = { title: 'lastGLANCE', sub: 'Not running', icon: 'PlugZap', accent: GREY, dim: true };
export const NOT_READY: KeyView = { title: 'lastGLANCE', sub: 'Open the app', icon: 'Hourglass', accent: GREY, dim: true };

/** Whole days since an ISO time, as a short label: today, 3d, 2w, 4mo. */
export function sinceLabel(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const days = Math.floor((now - Date.parse(iso)) / DAY);
  if (!Number.isFinite(days) || days < 1) return 'today';
  if (days < 14) return `${days}d`;
  if (days < 60) return `${Math.floor(days / 7)}w`;
  return `${Math.floor(days / 30)}mo`;
}

/** Whole days from today to a local YYYY-MM-DD, on this computer's calendar. */
export function daysUntil(on: string, now: number): number {
  const [y, m, d] = on.split('-').map(Number);
  const today = new Date(now);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  return Math.round((new Date(y, m - 1, d).getTime() - start) / DAY);
}

function whenLabel(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days}d`;
}

/** Shorten to fit a key, on a word where one is near. */
export function fit(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

function choreView(c: DeckChore, now: number, sub?: string): KeyView {
  return {
    title: c.name,
    sub: sub ?? (c.justDone ? 'Done' : sinceLabel(c.lastCompletedAt, now)),
    icon: c.icon ?? 'CircleCheck',
    accent: c.justDone ? GREEN : c.color ?? GREY,
    ratio: c.ratio,
  };
}

/** The Chore key: one chosen chore, pressed to mark it done. */
export function choreKey(state: DeckState | null, choreId: string | null, now: number): { view: KeyView; choreId: string | null } {
  if (!state) return { view: OFFLINE, choreId: null };
  if (!state.ready) return { view: NOT_READY, choreId: null };
  if (!choreId) return { view: { title: 'Chore', sub: 'Choose one', icon: 'CircleCheck', accent: GREY, dim: true }, choreId: null };
  const c = state.chores.find((x) => x.id === choreId);
  if (!c) return { view: { title: 'Chore', sub: 'Not found', icon: 'CircleHelp', accent: GREY, dim: true }, choreId: null };
  return { view: choreView(c, now), choreId: c.id };
}

/** Wrap an index into 0..count-1 (0 when there is nothing). */
export function wrap(index: number, count: number): number {
  return count === 0 ? 0 : ((index % count) + count) % count;
}

/** The Due key: the due chores one at a time, most overdue first; `index` is where this key is in the list. */
export function dueKey(state: DeckState | null, index: number, now: number): { view: KeyView; choreId: string | null; index: number; count: number } {
  if (!state) return { view: OFFLINE, choreId: null, index: 0, count: 0 };
  if (!state.ready) return { view: NOT_READY, choreId: null, index: 0, count: 0 };
  const due = state.due.map((id) => state.chores.find((c) => c.id === id)).filter((c): c is DeckChore => !!c);
  if (due.length === 0) return { view: { title: 'Nothing due', sub: 'All done', icon: 'PartyPopper', accent: GREEN }, choreId: null, index: 0, count: 0 };
  const i = wrap(index, due.length);
  const c = due[i];
  const position = due.length > 1 ? `${i + 1}/${due.length} · ` : '';
  return { view: choreView(c, now, `${position}${sinceLabel(c.lastCompletedAt, now)}`), choreId: c.id, index: i, count: due.length };
}

/** The Overview key: how many chores are overdue, and soon. */
export function overviewKey(state: DeckState | null): KeyView {
  if (!state) return OFFLINE;
  if (!state.ready) return NOT_READY;
  const { overdue, soon } = state.counts;
  if (overdue === 0 && soon === 0) return { title: '0', sub: 'Nothing due', accent: GREEN, big: true, icon: null };
  return {
    title: String(overdue > 0 ? overdue : soon),
    sub: overdue > 0 ? (soon > 0 ? `overdue · ${soon} soon` : 'overdue') : 'soon',
    accent: overdue > 0 ? RED : AMBER,
    big: true,
    icon: null,
  };
}

/** The Reach out key: the person at the top of Reach out. */
export function reachOutKey(state: DeckState | null): { view: KeyView; personId: string | null } {
  if (!state) return { view: OFFLINE, personId: null };
  if (!state.ready) return { view: NOT_READY, personId: null };
  const p = state.reachOut[0];
  if (!p) return { view: { title: 'Reach out', sub: 'All caught up', icon: 'HeartHandshake', accent: GREEN, dim: true }, personId: null };
  return { view: { title: p.name, sub: p.detail, icon: 'MessageCircleHeart', accent: p.color, ratio: p.ratio }, personId: p.id };
}

/** The Coming up key: the next birthday or date. */
export function comingUpKey(state: DeckState | null, now: number): { view: KeyView; personId: string | null } {
  if (!state) return { view: OFFLINE, personId: null };
  if (!state.ready) return { view: NOT_READY, personId: null };
  const d = state.comingUp[0];
  if (!d) return { view: { title: 'Coming up', sub: 'Nothing soon', icon: 'CalendarHeart', accent: GREY, dim: true }, personId: null };
  const days = daysUntil(d.on, now);
  return { view: { title: d.name, sub: `${d.label}, ${whenLabel(days)}`, icon: days <= 0 ? 'PartyPopper' : 'Cake', accent: PINK }, personId: d.personId };
}

/** The Add chore key. */
export function addKey(state: DeckState | null): KeyView {
  if (!state) return OFFLINE;
  return { title: 'Add chore', icon: 'Plus', accent: BLUE };
}
