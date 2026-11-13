import { describe, expect, it } from 'vitest';
import { cadenceColor, deckCompletion, deckOpenToken, deckState, prunePresses, stateFor } from './deckModel';
import { getCadenceColor } from '../src/utils/cadence';
import type { TraySnapshot } from './trayModel';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const chore = (syncId: string, cadence: number | null, lastDaysAgo: number | null, over: Partial<TraySnapshot['chores'][number]> = {}) => ({
  syncId, name: syncId, icon: null, categoryName: 'Home', state: 'fresh' as const, lastCompletedAt: lastDaysAgo === null ? null : ago(lastDaysAgo),
  elapsedDays: lastDaysAgo, targetCadenceDays: cadence, ratio: null, color: null, pinned: false, ...over,
});
const snapshot: TraySnapshot = {
  generatedAt: NOW - 3 * DAY,   // three days old: the deck must not draw it as it was
  chores: [chore('water', 7, 6), chore('dust', 7, 2), chore('fridge', 30, 40), chore('kettle', null, 3), chore('new', 7, null, { pinned: true })],
  reachOut: [{ syncId: 'p1', name: 'Maya', ratio: 1.4, color: '#ef4444', detail: 'Birthday in 2 days' }],
  comingUp: [{ personSyncId: 'p1', name: 'Maya', label: 'Birthday (36)', on: '2026-11-15' }],
};

describe('the deck state', () => {
  it('ages every chore to now, by the app\'s thresholds and colours', () => {
    const s = deckState(snapshot, new Map(), NOW);
    const byId = Object.fromEntries(s.chores.map((c) => [c.id, c]));
    expect(byId.water).toMatchObject({ ratio: 0.86, state: 'soon' });
    expect(byId.dust).toMatchObject({ ratio: 0.29, state: 'fresh' });
    expect(byId.fridge).toMatchObject({ ratio: 1.33, state: 'overdue' });
    expect(byId.kettle).toMatchObject({ ratio: null, state: 'none', color: null });
    expect(byId.new).toMatchObject({ ratio: null, state: 'none', pinned: true });
    expect(s.due).toEqual(['fridge', 'water']);
    expect(s.counts).toEqual({ overdue: 1, soon: 1 });
    expect(s.ready).toBe(true);
    // A minute later the same snapshot reads a minute older.
    expect(deckState(snapshot, new Map(), NOW + 2 * DAY).chores.find((c) => c.id === 'water')!.state).toBe('overdue');
  });

  it('draws the colour the app draws', () => {
    for (const r of [0, 0.3, 0.75, 0.99, 1, 1.5, 2, 3]) expect(cadenceColor(r), String(r)).toBe(getCadenceColor(r));
    expect(stateFor(0.75)).toBe('soon');
    expect(stateFor(1)).toBe('overdue');
  });

  it('shows a chore done here as done at once, before the app catches up', () => {
    const s = deckState(snapshot, new Map([['fridge', NOW - 1000]]), NOW);
    expect(s.chores.find((c) => c.id === 'fridge')).toMatchObject({ justDone: true, state: 'fresh', ratio: 0 });
    expect(s.due).toEqual(['water']);
  });

  it('says it is not ready before the first snapshot, rather than nothing due', () => {
    expect(deckState(null, new Map(), NOW)).toMatchObject({ ready: false, chores: [], due: [], counts: { overdue: 0, soon: 0 } });
  });

  it('carries People as the snapshot words them', () => {
    const s = deckState(snapshot, new Map(), NOW);
    expect(s.reachOut).toEqual([{ id: 'p1', name: 'Maya', ratio: 1.4, color: '#ef4444', detail: 'Birthday in 2 days' }]);
    expect(s.comingUp).toEqual([{ personId: 'p1', name: 'Maya', label: 'Birthday (36)', on: '2026-11-15' }]);
  });
});

describe('a press', () => {
  it('completes a known chore once a minute at most, whoever did it last', () => {
    expect(deckCompletion('water', snapshot, new Map(), NOW)).toBe('ok');
    expect(deckCompletion('gone', snapshot, new Map(), NOW)).toBe('unknown_chore');
    expect(deckCompletion('water', null, new Map(), NOW)).toBe('unknown_chore');
    expect(deckCompletion('water', snapshot, new Map([['water', NOW - 30_000]]), NOW)).toBe('too_soon');
    expect(deckCompletion('water', snapshot, new Map([['water', NOW - 61_000]]), NOW)).toBe('ok');
    // Once the app has reflected a completion it settles the one made here: the snapshot's own record still counts.
    const reflected = { ...snapshot, chores: snapshot.chores.map((c) => (c.syncId === 'water' ? { ...c, lastCompletedAt: new Date(NOW - 20_000).toISOString() } : c)) };
    expect(deckCompletion('water', reflected, new Map(), NOW)).toBe('too_soon');
    expect(deckCompletion('water', reflected, new Map(), NOW + 60_000)).toBe('ok');
    // A press settled too early (a snapshot built after it from data read before it) is still remembered by the deck.
    const pressed = new Map([['water', NOW - 5_000]]);
    expect(deckCompletion('water', snapshot, new Map(), NOW, pressed)).toBe('too_soon');
    prunePresses(pressed, NOW + 60_000);
    expect(pressed.size).toBe(0);
  });

  it('opens the app, Add chore, Soon, or what the snapshot holds, and nothing else', () => {
    expect(deckOpenToken(null, snapshot)).toBeNull();
    expect(deckOpenToken('action:add', snapshot)).toBe('action:add');
    expect(deckOpenToken('filter:soon', snapshot)).toBe('filter:soon');
    expect(deckOpenToken('chore:water', snapshot)).toBe('chore:water');
    expect(deckOpenToken('log:p1', snapshot)).toBe('log:p1');
    expect(deckOpenToken('chore:gone', snapshot)).toBe(false);
    expect(deckOpenToken('action:delete', snapshot)).toBe(false);
  });
});
