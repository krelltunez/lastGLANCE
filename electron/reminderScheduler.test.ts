import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReminderScheduler, MAX_TIMER_MS, MISSED_WINDOW_MS, parseReminder, type ScheduledReminder } from './reminderScheduler';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const HOUR = 60 * 60 * 1000;
const T0 = Date.parse('2026-11-10T12:00:00Z');
const reminder = (id: number, at: number, extra: Partial<ScheduledReminder> = {}): ScheduledReminder =>
  ({ id, title: `Chore ${id}`, body: "It's been 7 days", at, open: `chore:c${id}`, actions: [], extra: { choreSyncId: `c${id}` }, ...extra });

function setup(start = T0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lastglance-reminders-'));
  dirs.push(dir);
  const file = path.join(dir, 'reminders.json');
  let t = start;
  const fired: number[] = [];
  const logs: string[] = [];
  let armed: { fn: () => void; ms: number } | null = null;
  const make = () => createReminderScheduler({
    file,
    fire: (r) => fired.push(r.id),
    now: () => t,
    setTimer: (fn, ms) => { armed = { fn, ms }; return armed; },
    clearTimer: (h) => { if (armed === h) armed = null; },
    log: (m) => logs.push(m),
  });
  return {
    file, fired, logs, make,
    s: make(),
    advance: (ms: number) => { t += ms },
    get armed() { return armed },
    runTimer: () => { const a = armed; armed = null; a?.fn() },
  };
}

describe('the desktop reminder scheduler', () => {
  it('arms for the next reminder due, capped at an hour, and fires it once', () => {
    const k = setup();
    k.s.schedule([reminder(1, T0 + 30 * 60 * 1000), reminder(2, T0 + 5 * HOUR)]);
    expect(k.armed?.ms).toBe(30 * 60 * 1000);
    k.advance(30 * 60 * 1000);
    k.runTimer();
    expect(k.fired).toEqual([1]);
    expect(k.s.pending().map((r) => r.id)).toEqual([2]);       // a fired reminder leaves the schedule
    expect(k.armed?.ms).toBe(MAX_TIMER_MS);                     // 4.5 h away: re-check within the hour
  });

  it('replaces by id and cancels by id', () => {
    const k = setup();
    k.s.schedule([reminder(1, T0 + HOUR)]);
    k.s.schedule([reminder(1, T0 + 2 * HOUR, { body: 'changed' })]);
    expect(k.s.pending()).toHaveLength(1);
    expect(k.s.pending()[0].body).toBe('changed');
    k.s.cancel([1]);
    expect(k.s.pending()).toEqual([]);
    expect(k.armed).toBeNull();
  });

  it('keeps the schedule across a restart', () => {
    const k = setup();
    k.s.schedule([reminder(1, T0 + HOUR)]);
    const again = k.make();
    expect(again.pending().map((r) => r.id)).toEqual([1]);
  });

  it('on launch, fires a reminder missed within 12 hours once and drops older ones', () => {
    const k = setup();
    k.s.schedule([reminder(1, T0 + HOUR), reminder(2, T0 + 2 * HOUR)]);
    k.s.stop();
    k.advance(2 * HOUR + MISSED_WINDOW_MS - 1);                  // asleep: #1 is 13 h late, #2 just under 12 h
    const relaunched = k.make();
    relaunched.rearm();
    expect(k.fired).toEqual([2]);
    expect(k.logs.some((l) => l.includes('reminder 1') && l.includes('dropped'))).toBe(true);
    expect(relaunched.pending()).toEqual([]);
    relaunched.rearm();
    expect(k.fired).toEqual([2]);                                // once
  });

  it('refuses malformed reminders and keeps only real actions', () => {
    const k = setup();
    expect(k.s.schedule([{ id: 'x' }, null, reminder(3, T0 + HOUR)])).toBe(1);
    const parsed = parseReminder({
      ...reminder(4, T0),
      actions: [
        { id: 'mark_done', title: 'Mark done', command: { action: 'complete', payload: { chore_id: 'c4' } } },
        { id: 'log', title: 'Log', open: 'log:p1' },
        { id: 'nothing', title: 'Does nothing' },
      ],
    });
    expect(parsed?.actions.map((a) => a.id)).toEqual(['mark_done', 'log']);
  });

  it('a show that throws is logged, not fatal', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lastglance-reminders-'));
    dirs.push(dir);
    const logs: string[] = [];
    const s = createReminderScheduler({ file: path.join(dir, 'r.json'), fire: () => { throw new Error('no display') }, now: () => T0, setTimer: () => null, clearTimer: () => {}, log: (m) => logs.push(m) });
    s.schedule([reminder(1, T0 - 1)]);
    expect(logs[0]).toContain('could not show');
  });
});
