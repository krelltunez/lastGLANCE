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
  /** A small mark in the top corner: where this key is in its list ("2/5"). */
  badge?: string;
}

export const GREY = '#64748b';
export const GREEN = '#22c55e';
export const AMBER = '#f59e0b';
export const RED = '#ef4444';
export const BLUE = '#38bdf8';
/** A date within a week, as the app marks it (pink there), toned down for a lit key. */
export const ROSE = '#c27a9c';
/** A date further off: the app's quiet slate. */
export const SLATE = '#94a3b8';

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

/**
 * How long since a chore was done, in the app's words: the app works it out
 * (DeckChore.since, calendar days in the user's zone, as its chore list says
 * it) and this only shortens it. An app from before that sends none: the old
 * reckoning, whole days.
 */
export function sinceText(c: DeckChore, now: number): string {
  const s = c.since;
  if (!s) {
    const old = sinceLabel(c.lastCompletedAt, now);
    return old === 'never' || old === 'today' ? old : `${old} ago`;
  }
  switch (s.kind) {
    case 'never': return 'never';
    case 'just_now': return 'just now';
    case 'minutes': return `${s.count}m ago`;
    case 'hours': return `${s.count}h ago`;
    case 'yesterday': return 'yesterday';
    case 'days': return `${s.count}d ago`;
  }
}

/** When a chore comes due, in the app's words, or null when it has no cadence (or the app sent none). */
export function dueText(c: DeckChore): string | null {
  const d = c.nextDue;
  if (!d) return null;
  switch (d.kind) {
    case 'none': return null;
    case 'now': return 'due now';
    case 'today': return 'due today';
    case 'tomorrow': return 'due tomorrow';
    case 'days': return `due in ${d.count}d`;
  }
}

/** How often the Chore key turns between "3d ago" and "due now". */
export const ROTATE_MS = 4000;

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
    sub: c.justDone ? 'Done' : sub ?? sinceText(c, now),
    icon: c.icon ?? 'CircleCheck',
    accent: c.justDone ? GREEN : c.color ?? GREY,
    ratio: c.ratio,
  };
}

/**
 * The Chore key: one chosen chore, pressed to mark it done. Its second line
 * turns between how long since ("3d ago") and when it comes due ("due now"),
 * a turn every ROTATE_MS: `turn` counts the turns, even for since.
 */
export function choreKey(state: DeckState | null, choreId: string | null, now: number, turn = 0): { view: KeyView; choreId: string | null } {
  if (!state) return { view: OFFLINE, choreId: null };
  if (!state.ready) return { view: NOT_READY, choreId: null };
  if (!choreId) return { view: { title: 'Chore', sub: 'Choose one', icon: 'CircleCheck', accent: GREY, dim: true }, choreId: null };
  const c = state.chores.find((x) => x.id === choreId);
  if (!c) return { view: { title: 'Chore', sub: 'Not found', icon: 'CircleHelp', accent: GREY, dim: true }, choreId: null };
  const due = dueText(c);
  return { view: choreView(c, now, turn % 2 === 1 && due ? due : undefined), choreId: c.id };
}

/** Where a key is in its list, when the list has more than one. */
const badge = (i: number, count: number) => (count > 1 ? `${i + 1}/${count}` : undefined);

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
  return { view: { ...choreView(c, now), badge: badge(i, due.length) }, choreId: c.id, index: i, count: due.length };
}

/** The Pinned key: the pinned chores in season, in the app's Pinned order, one at a time. */
export function pinnedKey(state: DeckState | null, index: number, now: number): { view: KeyView; choreId: string | null; index: number; count: number } {
  if (!state) return { view: OFFLINE, choreId: null, index: 0, count: 0 };
  if (!state.ready) return { view: NOT_READY, choreId: null, index: 0, count: 0 };
  // An app from before the pinned list: the pinned chores as they come, most overdue first.
  const ids = state.pinned ?? state.chores.filter((c) => c.pinned).sort((a, b) => (b.ratio ?? -1) - (a.ratio ?? -1)).map((c) => c.id);
  const pinned = ids.map((id) => state.chores.find((c) => c.id === id)).filter((c): c is DeckChore => !!c);
  if (pinned.length === 0) return { view: { title: 'Pinned', sub: 'Nothing pinned', icon: 'Pin', accent: GREY, dim: true }, choreId: null, index: 0, count: 0 };
  const i = wrap(index, pinned.length);
  const c = pinned[i];
  return { view: { ...choreView(c, now), badge: badge(i, pinned.length) }, choreId: c.id, index: i, count: pinned.length };
}

/** The Soon key (first called Overview): how many chores are overdue, and soon. */
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

/** The Reach out key: the people in Reach out, in its order, one at a time (the first on a key). */
export function reachOutKey(state: DeckState | null, index = 0): { view: KeyView; personId: string | null; index: number; count: number } {
  if (!state) return { view: OFFLINE, personId: null, index: 0, count: 0 };
  if (!state.ready) return { view: NOT_READY, personId: null, index: 0, count: 0 };
  const count = state.reachOut.length;
  if (count === 0) return { view: { title: 'Reach out', sub: 'All caught up', icon: 'HeartHandshake', accent: GREEN, dim: true }, personId: null, index: 0, count: 0 };
  const i = wrap(index, count);
  const p = state.reachOut[i];
  return { view: { title: p.name, sub: p.detail, icon: 'MessageCircleHeart', accent: p.color, ratio: p.ratio, badge: badge(i, count) }, personId: p.id, index: i, count };
}

/** A date within this many days is marked, as the app's Coming up tiles mark it. */
export const DATE_SOON_DAYS = 7;

/** The Coming up key: the birthdays and dates ahead, soonest first, one at a time (the first on a key). */
export function comingUpKey(state: DeckState | null, now: number, index = 0): { view: KeyView; personId: string | null; index: number; count: number } {
  if (!state) return { view: OFFLINE, personId: null, index: 0, count: 0 };
  if (!state.ready) return { view: NOT_READY, personId: null, index: 0, count: 0 };
  const count = state.comingUp.length;
  if (count === 0) return { view: { title: 'Coming up', sub: 'Nothing soon', icon: 'CalendarHeart', accent: GREY, dim: true }, personId: null, index: 0, count: 0 };
  const i = wrap(index, count);
  const d = state.comingUp[i];
  const days = daysUntil(d.on, now);
  return {
    view: { title: d.name, sub: `${d.label}, ${whenLabel(days)}`, icon: days <= 0 ? 'PartyPopper' : 'Cake', accent: days <= DATE_SOON_DAYS ? ROSE : SLATE, badge: badge(i, count) },
    personId: d.personId, index: i, count,
  };
}

/** The Add chore key. */
export function addKey(state: DeckState | null): KeyView {
  if (!state) return OFFLINE;
  return { title: 'Add chore', icon: 'Plus', accent: BLUE };
}
