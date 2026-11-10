// The tray's data and layout (docs/desktop-app.md, section 7, The tray popup is
// a widget). The tray never opens the database or runs a sync engine: the main
// window pushes the widget snapshot (src/native/snapshot.ts), main keeps the
// part the tray shows, and a "Mark done" queues a completion (commandQueue.ts)
// that the page applies. Until the page's next snapshot shows it, the chore is
// hidden here, as the phones' widgets update optimistically.
//
// Pure functions, tested without Electron; main.ts owns the Tray, the popup
// window and the Linux menu.

export interface TrayChore {
  syncId: string;
  name: string;
  categoryName: string | null;
  state: 'overdue' | 'soon';
  elapsedDays: number | null;
  targetCadenceDays: number | null;
  ratio: number | null;
}

export interface TraySnapshot {
  generatedAt: number;
  chores: TrayChore[];
}

export interface TrayState {
  due: TrayChore[];
  /** Overdue and soon, less the ones completed here and not yet in a snapshot. */
  counts: { overdue: number; soon: number };
  /** False until the main window has pushed a snapshot. */
  ready: boolean;
}

export const TRAY_DUE_LIMIT = 8;
export const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

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
    if (c.state !== 'overdue' && c.state !== 'soon') continue;
    if (typeof c.syncId !== 'string' || typeof c.name !== 'string') continue;
    chores.push({
      syncId: c.syncId,
      name: c.name,
      categoryName: typeof c.categoryName === 'string' ? c.categoryName : null,
      state: c.state,
      elapsedDays: num(c.elapsedDays),
      targetCadenceDays: num(c.targetCadenceDays),
      ratio: num(c.ratio),
    });
  }
  return { generatedAt, chores };
}

/** Overdue first, then soon, each most overdue first; less the ones done here. */
export function trayState(snapshot: TraySnapshot | null, doneHere: ReadonlyMap<string, number>, limit = TRAY_DUE_LIMIT): TrayState {
  if (!snapshot) return { due: [], counts: { overdue: 0, soon: 0 }, ready: false };
  const open = snapshot.chores.filter((c) => !doneHere.has(c.syncId));
  const rank = (c: TrayChore) => (c.state === 'overdue' ? 0 : 1);
  const sorted = [...open].sort((a, b) => rank(a) - rank(b) || (b.ratio ?? 0) - (a.ratio ?? 0) || a.name.localeCompare(b.name));
  return {
    due: sorted.slice(0, limit),
    counts: { overdue: open.filter((c) => c.state === 'overdue').length, soon: open.filter((c) => c.state === 'soon').length },
    ready: true,
  };
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
