// The tray's data and layout (docs/desktop-app.md, section 7, The tray popup is
// a widget). The tray never opens the database or runs a sync engine: the main
// window pushes the widget snapshot (src/native/snapshot.ts), main keeps the
// part the tray shows, and a "Mark done" queues a completion (commandQueue.ts)
// that the page applies. Until the page's next snapshot shows it, the chore is
// hidden here, as the phones' widgets update optimistically.
//
// Pure functions, tested without Electron; main.ts owns the Tray, the popup
// window and the Linux menu.

export type ChoreState = 'overdue' | 'soon' | 'fresh' | 'none';
const CHORE_STATES: ReadonlySet<string> = new Set(['overdue', 'soon', 'fresh', 'none']);

export interface TrayChore {
  syncId: string;
  name: string;
  /** A lucide icon name, as the app draws it. */
  icon: string | null;
  categoryName: string | null;
  state: ChoreState;
  lastCompletedAt: string | null;
  elapsedDays: number | null;
  targetCadenceDays: number | null;
  ratio: number | null;
  color: string | null;
  /** Pinned and in season, as the snapshot says (src/native/snapshot.ts). */
  pinned: boolean;
}

/** The snapshot's Reach out row (src/native/peopleSnapshot.ts), text already in the app's language. */
export interface TrayPerson {
  syncId: string;
  name: string;
  ratio: number | null;
  color: string;
  detail: string;
}

/** The snapshot's Coming up row: `on` is the local day, YYYY-MM-DD. */
export interface TrayDate {
  personSyncId: string;
  name: string;
  label: string;
  on: string;
}

export interface TraySnapshot {
  generatedAt: number;
  chores: TrayChore[];
  reachOut: TrayPerson[];
  comingUp: TrayDate[];
}

export interface TrayState {
  due: TrayChore[];
  /** Every chore, for the popup's search (TRAY_CHORE_LIMIT at most), less the ones done here. */
  chores: TrayChore[];
  /** Overdue and soon, less the ones completed here and not yet in a snapshot. */
  counts: { overdue: number; soon: number };
  reachOut: TrayPerson[];
  comingUp: TrayDate[];
  /** False until the main window has pushed a snapshot. */
  ready: boolean;
}

export const TRAY_DUE_LIMIT = 8;
export const TRAY_PEOPLE_LIMIT = 5;
export const TRAY_CHORE_LIMIT = 2000;
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const text = (v: unknown, max = 300): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const COLOR = /^#[0-9a-fA-F]{6}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function parsePeople(raw: unknown): { reachOut: TrayPerson[]; comingUp: TrayDate[] } {
  const p = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const reachOut: TrayPerson[] = [];
  for (const item of Array.isArray(p.reachOut) ? p.reachOut : []) {
    const r = item as Record<string, unknown> | null;
    const syncId = text(r?.syncId, 128), name = text(r?.name);
    if (!syncId || !name) continue;
    reachOut.push({ syncId, name, ratio: num(r?.ratio), color: COLOR.test(String(r?.color)) ? String(r?.color) : '#64748b', detail: text(r?.detail) ?? '' });
  }
  const comingUp: TrayDate[] = [];
  for (const item of Array.isArray(p.comingUp) ? p.comingUp : []) {
    const d = item as Record<string, unknown> | null;
    const personSyncId = text(d?.personSyncId, 128), name = text(d?.name), on = text(d?.on, 10);
    if (!personSyncId || !name || !on || !DAY.test(on)) continue;
    comingUp.push({ personSyncId, name, label: text(d?.label) ?? '', on });
  }
  return { reachOut, comingUp };
}

/** The tray's part of a widget snapshot, or null if it is not one. */
export function parseTraySnapshot(json: unknown): TraySnapshot | null {
  if (typeof json !== 'string' || json.length > SNAPSHOT_MAX_BYTES) return null;
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const generatedAt = typeof s.generatedAt === 'string' ? Date.parse(s.generatedAt) : NaN;
  if (!Number.isFinite(generatedAt) || !Array.isArray(s.chores)) return null;
  const chores: TrayChore[] = [];
  for (const item of s.chores) {
    if (!item || typeof item !== 'object') continue;
    const c = item as Record<string, unknown>;
    if (typeof c.state !== 'string' || !CHORE_STATES.has(c.state)) continue;
    if (typeof c.syncId !== 'string' || typeof c.name !== 'string') continue;
    chores.push({
      syncId: c.syncId,
      name: c.name,
      icon: text(c.icon, 64),
      categoryName: typeof c.categoryName === 'string' ? c.categoryName : null,
      state: c.state as ChoreState,
      lastCompletedAt: text(c.lastCompletedAt, 40),
      elapsedDays: num(c.elapsedDays),
      targetCadenceDays: num(c.targetCadenceDays),
      ratio: num(c.ratio),
      color: COLOR.test(String(c.color)) ? String(c.color) : null,
      pinned: c.pinned === true,
    });
  }
  return { generatedAt, chores: chores.slice(0, TRAY_CHORE_LIMIT), ...parsePeople(s.people) };
}

/** Overdue first, then soon, each most overdue first; less the ones done here. */
export function trayState(snapshot: TraySnapshot | null, doneHere: ReadonlyMap<string, number>, limit = TRAY_DUE_LIMIT): TrayState {
  if (!snapshot) return { due: [], chores: [], counts: { overdue: 0, soon: 0 }, reachOut: [], comingUp: [], ready: false };
  const open = snapshot.chores.filter((c) => !doneHere.has(c.syncId));
  const rank = (c: TrayChore) => (c.state === 'overdue' ? 0 : 1);
  const due = open.filter((c) => c.state === 'overdue' || c.state === 'soon');
  const sorted = [...due].sort((a, b) => rank(a) - rank(b) || (b.ratio ?? 0) - (a.ratio ?? 0) || a.name.localeCompare(b.name));
  return {
    due: sorted.slice(0, limit),
    chores: open,
    counts: { overdue: open.filter((c) => c.state === 'overdue').length, soon: open.filter((c) => c.state === 'soon').length },
    reachOut: snapshot.reachOut.slice(0, TRAY_PEOPLE_LIMIT),
    comingUp: snapshot.comingUp.slice(0, TRAY_PEOPLE_LIMIT),
    ready: true,
  };
}

/**
 * The deep-link token the popup may open: a chore or person it shows, the
 * quick-log sheet for a person it shows, People, or (null) just the app.
 */
export function trayOpenToken(token: unknown, snapshot: TraySnapshot | null): string | null {
  if (typeof token !== 'string' || !snapshot) return null;
  if (token === 'people') return token;
  const colon = token.indexOf(':');
  const kind = token.slice(0, colon), id = token.slice(colon + 1);
  if (kind === 'chore') return snapshot.chores.some((c) => c.syncId === id) ? token : null;
  const shown = snapshot.reachOut.some((p) => p.syncId === id) || snapshot.comingUp.some((d) => d.personSyncId === id);
  if ((kind === 'person' || kind === 'log') && shown) return token;
  return null;
}

/** Completions made here that a snapshot generated after them now reflects. */
export function settledCompletions(doneHere: ReadonlyMap<string, number>, snapshot: TraySnapshot): string[] {
  return [...doneHere].filter(([, at]) => at <= snapshot.generatedAt).map(([id]) => id);
}

export interface Rect { x: number; y: number; width: number; height: number }

/**
 * Where the popup goes: centered on the tray icon, below it when the icon is
 * in the top half of the screen (the macOS menu bar, a top panel), above it
 * otherwise (the Windows taskbar), kept inside the work area.
 */
export function popupPosition(icon: Rect, size: { width: number; height: number }, workArea: Rect, gap = 6): { x: number; y: number } {
  const below = icon.y + icon.height / 2 < workArea.y + workArea.height / 2;
  let x = Math.round(icon.x + icon.width / 2 - size.width / 2);
  let y = below ? icon.y + icon.height + gap : icon.y - size.height - gap;
  x = Math.min(Math.max(x, workArea.x + gap), workArea.x + workArea.width - size.width - gap);
  y = Math.min(Math.max(y, workArea.y + gap), workArea.y + workArea.height - size.height - gap);
  return { x, y };
}

/**
 * On Windows a click on the tray icon while the popup is open first takes
 * focus from the popup (blur hides it) and only then delivers the click, which
 * would find the popup hidden and show it again: the icon could rarely close
 * its own popup. A click this soon after a blur-hide is that same click, so it
 * leaves the popup closed. After dayGLANCE's electron/trayPopup.ts.
 */
export const BLUR_CLICK_WINDOW_MS = 300;

export function isClickAfterBlurHide(now: number, lastBlurHideAt: number | null): boolean {
  return lastBlurHideAt != null && now - lastBlurHideAt >= 0 && now - lastBlurHideAt < BLUR_CLICK_WINDOW_MS;
}

export interface TrayMenuLabels {
  open: string;
  quit: string;
  markDone: string;
  nothingDue: string;
}

export type TrayMenuItem =
  | { kind: 'open' | 'quit' | 'separator' | 'empty'; label?: string }
  | { kind: 'chore'; label: string; syncId: string; markDone: string; open: string };

/**
 * The Linux tray menu (AppIndicator delivers no reliable clicks, so no
 * popup): Open, the due chores each with Mark done, Quit. Also the right-click
 * menu elsewhere, without the chores.
 */
export function trayMenuItems(state: TrayState, labels: TrayMenuLabels, withChores: boolean): TrayMenuItem[] {
  const items: TrayMenuItem[] = [{ kind: 'open', label: labels.open }];
  if (withChores) {
    items.push({ kind: 'separator' });
    if (state.due.length === 0) items.push({ kind: 'empty', label: labels.nothingDue });
    for (const c of state.due) items.push({ kind: 'chore', label: c.name, syncId: c.syncId, markDone: labels.markDone, open: labels.open });
  }
  items.push({ kind: 'separator' }, { kind: 'quit', label: labels.quit });
  return items;
}
