// The desktop reminder scheduler (docs/desktop-app.md, section 7, Reminders).
// The page keeps its reminder logic (src/native/reminders.ts: the desired-
// versus-pending diff, the ids, the People dates and digest) and calls the
// LocalNotifications contract; on the desktop that contract lands here.
//
//  - The schedule persists to userData/reminders.json, so a quit and relaunch,
//    or a crash, keeps it.
//  - One timer is armed for the next reminder due, never more than an hour out:
//    a long timeout would drift across a sleep or a clock change, and the hour
//    cap re-checks the wall clock. Main also re-arms on resume and unlock.
//  - On launch or resume, a reminder whose time passed within the last 12
//    hours fires once; older ones are dropped silently. A fired reminder leaves
//    the schedule (the page reschedules the chore's next crossing).
//
// What a reminder does when clicked is decided by the page and carried here:
// `open` is a deep-link token (deepLink.ts), and each action either opens a
// token or queues a command (commandQueue.ts). Main only shows and routes.

import fs from 'node:fs';
import { writeFileAtomicSync } from './atomicWrite.js';

export const REMINDERS_FILE = 'reminders.json';
export const MISSED_WINDOW_MS = 12 * 60 * 60 * 1000;
export const MAX_TIMER_MS = 60 * 60 * 1000;
export const REMINDER_LIMIT = 1000;

export interface ReminderAction {
  id: string;
  title: string;
  /** A deep-link token to open. */
  open?: string;
  /** A command to queue: handleIntent's vocabulary. */
  command?: { action: string; payload: Record<string, unknown> };
}

export interface ScheduledReminder {
  id: number;
  title: string;
  body: string;
  /** Epoch ms. */
  at: number;
  /** The deep-link token a click opens, or null to just show the app. */
  open: string | null;
  actions: ReminderAction[];
  /** The page's own data, handed back by `pending` for its diff. */
  extra: Record<string, unknown>;
}

const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

function parseAction(v: unknown): ReminderAction | null {
  if (!v || typeof v !== 'object') return null;
  const a = v as Record<string, unknown>;
  if (!str(a.id, 64) || !str(a.title, 200)) return null;
  const out: ReminderAction = { id: a.id, title: a.title };
  if (str(a.open, 200)) out.open = a.open;
  const c = a.command as Record<string, unknown> | undefined;
  if (c && typeof c === 'object' && str(c.action, 64) && c.payload && typeof c.payload === 'object' && !Array.isArray(c.payload)) {
    out.command = { action: c.action, payload: c.payload as Record<string, unknown> };
  }
  return out.open || out.command ? out : null;
}

/** A reminder from the page or the file, or null if malformed. */
export function parseReminder(v: unknown): ScheduledReminder | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'number' || !Number.isSafeInteger(r.id)) return null;
  if (!str(r.title, 500) || !str(r.body, 2000)) return null;
  if (typeof r.at !== 'number' || !Number.isFinite(r.at)) return null;
  const open = str(r.open, 200) ? r.open : null;
  const actions = Array.isArray(r.actions) ? r.actions.map(parseAction).filter((a): a is ReminderAction => a !== null).slice(0, 3) : [];
  const extra = r.extra && typeof r.extra === 'object' && !Array.isArray(r.extra) ? r.extra as Record<string, unknown> : {};
  return { id: r.id, title: r.title, body: r.body, at: r.at, open, actions, extra };
}

export interface ReminderSchedulerDeps {
  file: string;
  fire: (reminder: ScheduledReminder) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string) => void;
}

export function createReminderScheduler(deps: ReminderSchedulerDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timer: unknown = null;

  const load = (): Map<number, ScheduledReminder> => {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(deps.file, 'utf-8'));
      const list = Array.isArray(parsed) ? parsed.map(parseReminder).filter((r): r is ScheduledReminder => r !== null) : [];
      return new Map(list.map((r) => [r.id, r]));
    } catch {
      return new Map();
    }
  };
  let schedule = load();
  const save = () => {
    try { writeFileAtomicSync(deps.file, JSON.stringify([...schedule.values()])); } catch { /* kept in memory */ }
  };

  /** Fire what is due (missed within the window once, older dropped), then arm for the next one. */
  const rearm = (): void => {
    if (timer !== null) { clearTimer(timer); timer = null; }
    const t = now();
    let changed = false;
    for (const r of [...schedule.values()].sort((a, b) => a.at - b.at)) {
      if (r.at > t) break;
      schedule.delete(r.id);
      changed = true;
      if (t - r.at <= MISSED_WINDOW_MS) {
        try { deps.fire(r); } catch (e) { deps.log?.(`reminder ${r.id}: could not show: ${e instanceof Error ? e.message : String(e)}`); }
      } else {
        deps.log?.(`reminder ${r.id}: missed by more than 12 h, dropped`);
      }
    }
    if (changed) save();
    let next = Infinity;
    for (const r of schedule.values()) next = Math.min(next, r.at);
    if (next === Infinity) return;
    timer = setTimer(() => { timer = null; rearm(); }, Math.max(0, Math.min(next - t, MAX_TIMER_MS)));
  };

  return {
    /** Add or replace reminders by id. Returns how many were accepted. */
    schedule(list: unknown): number {
      if (!Array.isArray(list)) return 0;
      let accepted = 0;
      for (const item of list) {
        const r = parseReminder(item);
        if (!r) continue;
        if (!schedule.has(r.id) && schedule.size >= REMINDER_LIMIT) continue;
        schedule.set(r.id, r);
        accepted += 1;
      }
      if (accepted) { save(); rearm(); }
      return accepted;
    },
    cancel(ids: unknown): void {
      if (!Array.isArray(ids)) return;
      let changed = false;
      for (const id of ids) changed = schedule.delete(id as number) || changed;
      if (changed) { save(); rearm(); }
    },
    /** What is scheduled, as the page's diff reads it. */
    pending(): ScheduledReminder[] {
      return [...schedule.values()].sort((a, b) => a.at - b.at);
    },
    rearm,
    stop(): void {
      if (timer !== null) { clearTimer(timer); timer = null; }
    },
    /** Re-read the file (tests; a second process never writes it). */
    reload(): void { schedule = load(); },
  };
}

export type ReminderScheduler = ReturnType<typeof createReminderScheduler>;
