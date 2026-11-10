import { describe, expect, it } from 'vitest';
import { parseTraySnapshot, popupPosition, settledCompletions, trayMenuItems, trayOpenToken, trayState } from './trayModel';

const PEOPLE = {
  reachOut: [{ syncId: 'p1', name: 'Maya Chen', ratio: 1.4, color: '#ef4444', detail: 'Last contact 3 weeks ago' }, { syncId: 'bad' }],
  comingUp: [{ personSyncId: 'p2', name: 'Sam', label: 'Birthday (40)', on: '2026-11-14' }, { personSyncId: 'p3', name: 'X', label: 'y', on: 'soon' }],
  labels: {},
};
const snapshotJson = (chores: Record<string, unknown>[], generatedAt = '2026-11-10T12:00:00.000Z', people: unknown = PEOPLE) =>
  JSON.stringify({ version: 1, generatedAt, counts: { overdue: 0, soon: 0 }, heatmap: {}, weekStart: 1, chores, people });
const chore = (syncId: string, state: string, ratio: number, name = syncId) =>
  ({ syncId, name, icon: null, categoryName: 'Home', lastCompletedAt: null, elapsedDays: 9, targetCadenceDays: 7, ratio, color: null, state, pinned: false });

describe('the tray model', () => {
  it('keeps only due chores from the widget snapshot', () => {
    const s = parseTraySnapshot(snapshotJson([chore('a', 'overdue', 1.3), chore('b', 'fresh', 0.2), chore('c', 'soon', 0.9), { syncId: 1 }]));
    expect(s?.chores.map((c) => c.syncId)).toEqual(['a', 'c']);
    expect(s?.generatedAt).toBe(Date.parse('2026-11-10T12:00:00.000Z'));
    expect(parseTraySnapshot('{oops')).toBeNull();
    expect(parseTraySnapshot(JSON.stringify({ chores: [] }))).toBeNull();
  });

  it('carries what the cards draw, and the People block', () => {
    const s = parseTraySnapshot(snapshotJson([{ ...chore('a', 'overdue', 1.3), icon: 'Sprout', color: '#ef4444', lastCompletedAt: '2026-11-01T09:00:00.000Z' }]))!;
    expect(s.chores[0]).toMatchObject({ icon: 'Sprout', color: '#ef4444', lastCompletedAt: '2026-11-01T09:00:00.000Z' });
    expect(s.reachOut).toEqual([{ syncId: 'p1', name: 'Maya Chen', ratio: 1.4, color: '#ef4444', detail: 'Last contact 3 weeks ago' }]);
    expect(s.comingUp).toEqual([{ personSyncId: 'p2', name: 'Sam', label: 'Birthday (40)', on: '2026-11-14' }]);
    expect(parseTraySnapshot(snapshotJson([], undefined, null))?.reachOut).toEqual([]);   // a snapshot from before People
  });

  it('opens only what the popup shows', () => {
    const s = parseTraySnapshot(snapshotJson([chore('a', 'overdue', 1.3)]))!;
    expect(trayOpenToken('chore:a', s)).toBe('chore:a');
    expect(trayOpenToken('log:p1', s)).toBe('log:p1');
    expect(trayOpenToken('person:p2', s)).toBe('person:p2');
    expect(trayOpenToken('people', s)).toBe('people');
    expect(trayOpenToken('chore:zzz', s)).toBeNull();
    expect(trayOpenToken('action:add', s)).toBeNull();
    expect(trayOpenToken('chore:a', null)).toBeNull();
  });

  it('orders overdue first, most overdue first, and hides what was done here', () => {
    const s = parseTraySnapshot(snapshotJson([chore('soon1', 'soon', 0.95), chore('od1', 'overdue', 1.2), chore('od2', 'overdue', 2.0)]))!;
    expect(trayState(s, new Map()).due.map((c) => c.syncId)).toEqual(['od2', 'od1', 'soon1']);
    const after = trayState(s, new Map([['od2', Date.now()]]));
    expect(after.due.map((c) => c.syncId)).toEqual(['od1', 'soon1']);
    expect(after.counts).toEqual({ overdue: 1, soon: 1 });
    expect(trayState(null, new Map())).toEqual({ due: [], counts: { overdue: 0, soon: 0 }, reachOut: [], comingUp: [], ready: false });
  });

  it('settles a completion once a snapshot made after it arrives', () => {
    const s = parseTraySnapshot(snapshotJson([], '2026-11-10T12:00:10.000Z'))!;
    const done = new Map([['early', Date.parse('2026-11-10T12:00:05Z')], ['late', Date.parse('2026-11-10T12:00:20Z')]]);
    expect(settledCompletions(done, s)).toEqual(['early']);
  });

  it('puts the popup under a menu bar icon and above a taskbar icon, on screen', () => {
    const work = { x: 0, y: 25, width: 1440, height: 875 };
    expect(popupPosition({ x: 1200, y: 0, width: 24, height: 24 }, { width: 340, height: 460 }, work)).toEqual({ x: 1042, y: 31 });
    const taskbar = { x: 0, y: 0, width: 1920, height: 1040 };
    expect(popupPosition({ x: 1880, y: 1045, width: 24, height: 30 }, { width: 340, height: 460 }, taskbar)).toEqual({ x: 1574, y: 574 });
  });

  it('builds the Linux menu with the due chores, or says nothing is due', () => {
    const labels = { open: 'Open lastGLANCE', quit: 'Quit', markDone: 'Mark done', nothingDue: 'Nothing due' };
    const s = parseTraySnapshot(snapshotJson([chore('a', 'overdue', 1.3, 'Water plants')]))!;
    expect(trayMenuItems(trayState(s, new Map()), labels, true).map((i) => i.kind)).toEqual(['open', 'separator', 'chore', 'separator', 'quit']);
    expect(trayMenuItems(trayState(s, new Map([['a', 1]])), labels, true).map((i) => i.label ?? i.kind)).toContain('Nothing due');
    expect(trayMenuItems(trayState(s, new Map()), labels, false).map((i) => i.kind)).toEqual(['open', 'separator', 'quit']);
  });
});
