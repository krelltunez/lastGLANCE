import { describe, expect, it } from 'vitest';
import {
  addKey, choreKey, comingUpKey, daysUntil, dueKey, dueText, fit, NOT_READY, OFFLINE, overviewKey, pinnedKey, reachOutKey, ROSE,
  sinceLabel, sinceText, SLATE, wrap,
} from './keys';
import type { DeckChore, DeckState } from '../../electron/deckProtocol';

const NOW = new Date(2026, 10, 13, 12, 0, 0).getTime();   // local noon, so local dates are the dates below
const DAY = 86_400_000;
const chore = (id: string, over: Partial<DeckChore> = {}): DeckChore => ({
  id, name: id, icon: 'Sprout', category: 'Home', state: 'fresh', ratio: 0.3, color: '#22c55e',
  lastCompletedAt: new Date(NOW - 2 * DAY).toISOString(), cadenceDays: 7, pinned: false, justDone: false, ...over,
});
const state = (over: Partial<DeckState> = {}): DeckState => ({
  v: 1, type: 'lg:state', at: new Date(NOW).toISOString(), ready: true, counts: { overdue: 1, soon: 1 },
  chores: [chore('water', { state: 'overdue', ratio: 1.3, color: '#ef4444' }), chore('dust', { state: 'soon', ratio: 0.8 }), chore('wipe')],
  due: ['water', 'dust'],
  reachOut: [{ id: 'p1', name: 'Maya Chen', ratio: 1.4, color: '#ef4444', detail: 'Last contact 3 weeks ago' }],
  comingUp: [{ personId: 'p2', name: 'Sam', label: 'Birthday (40)', on: '2026-11-14' }],
  ...over,
});

describe('every key', () => {
  it('says the app is not running, or not ready, rather than nothing due', () => {
    for (const view of [choreKey(null, 'water', NOW).view, dueKey(null, 0, NOW).view, overviewKey(null), reachOutKey(null).view, comingUpKey(null, NOW).view, addKey(null)]) {
      expect(view).toBe(OFFLINE);
    }
    const notReady = state({ ready: false });
    for (const view of [choreKey(notReady, 'water', NOW).view, dueKey(notReady, 0, NOW).view, overviewKey(notReady), reachOutKey(notReady).view]) {
      expect(view).toBe(NOT_READY);
    }
  });
});

describe('the Chore key', () => {
  it('shows its chore in its cadence colour, how long since, and the bar', () => {
    expect(choreKey(state(), 'water', NOW)).toEqual({
      view: { title: 'water', sub: '2d ago', icon: 'Sprout', accent: '#ef4444', ratio: 1.3 },
      choreId: 'water',
    });
  });

  it('turns between how long since and when it comes due, in the app\'s words', () => {
    const s = state({ chores: [chore('water', { since: { kind: 'days', count: 2 }, nextDue: { kind: 'now' } })] });
    expect(choreKey(s, 'water', NOW, 0).view.sub).toBe('2d ago');
    expect(choreKey(s, 'water', NOW, 1).view.sub).toBe('due now');
    expect(choreKey(s, 'water', NOW, 2).view.sub).toBe('2d ago');
    // No cadence, nothing to turn to; and just done says so whatever the turn.
    const plain = state({ chores: [chore('water', { since: { kind: 'yesterday' }, nextDue: { kind: 'none' } })] });
    expect(choreKey(plain, 'water', NOW, 1).view.sub).toBe('yesterday');
    expect(choreKey(state({ chores: [chore('water', { justDone: true, nextDue: { kind: 'now' } })] }), 'water', NOW, 1).view.sub).toBe('Done');
  });

  it('shows done at once after a press, and asks to choose or says not found', () => {
    expect(choreKey(state({ chores: [chore('water', { justDone: true })] }), 'water', NOW).view).toMatchObject({ sub: 'Done', accent: '#22c55e' });
    expect(choreKey(state(), null, NOW)).toMatchObject({ choreId: null, view: { sub: 'Choose one', dim: true } });
    expect(choreKey(state(), 'gone', NOW)).toMatchObject({ choreId: null, view: { sub: 'Not found', dim: true } });
  });
});

describe('the Due key', () => {
  it('walks the due chores most overdue first, wrapping, with its place', () => {
    expect(dueKey(state(), 0, NOW)).toMatchObject({ choreId: 'water', index: 0, count: 2, view: { sub: '2d ago', badge: '1/2' } });
    expect(dueKey(state(), 1, NOW).choreId).toBe('dust');
    expect(dueKey(state(), 2, NOW)).toMatchObject({ choreId: 'water', index: 0 });
    expect(dueKey(state(), -1, NOW).choreId).toBe('dust');
    expect(dueKey(state({ due: [] }), 3, NOW)).toMatchObject({ choreId: null, count: 0, view: { title: 'Nothing due' } });
    expect(wrap(5, 0)).toBe(0);
  });
});

describe('the other keys', () => {
  it('count overdue first, then soon', () => {
    expect(overviewKey(state())).toMatchObject({ title: '1', sub: 'overdue · 1 soon', big: true, accent: '#ef4444' });
    expect(overviewKey(state({ counts: { overdue: 0, soon: 3 } }))).toMatchObject({ title: '3', sub: 'soon', accent: '#f59e0b' });
    expect(overviewKey(state({ counts: { overdue: 0, soon: 0 } }))).toMatchObject({ title: '0', sub: 'Nothing due' });
  });

  it('show who to reach out to, and the next date', () => {
    expect(reachOutKey(state())).toEqual({ personId: 'p1', index: 0, count: 1, view: { title: 'Maya Chen', sub: 'Last contact 3 weeks ago', icon: 'MessageCircleHeart', accent: '#ef4444', ratio: 1.4, badge: undefined } });
    expect(reachOutKey(state({ reachOut: [] }))).toMatchObject({ personId: null, view: { sub: 'All caught up' } });
    expect(comingUpKey(state(), NOW)).toMatchObject({ personId: 'p2', view: { title: 'Sam', sub: 'Birthday (40), tomorrow', icon: 'Cake' } });
    expect(comingUpKey(state({ comingUp: [{ personId: 'p2', name: 'Sam', label: 'Birthday', on: '2026-11-13' }] }), NOW).view).toMatchObject({ sub: 'Birthday, today', icon: 'PartyPopper' });
    expect(comingUpKey(state({ comingUp: [] }), NOW)).toMatchObject({ personId: null });
  });
});

describe('the lists a dial turns through', () => {
  const people = [
    { id: 'p1', name: 'Maya', ratio: 1.4, color: '#ef4444', detail: '3 weeks ago' },
    { id: 'p3', name: 'Ann', ratio: 1.1, color: '#f59e0b', detail: '2 weeks ago' },
  ];
  const dates = [
    { personId: 'p2', name: 'Sam', label: 'Birthday', on: '2026-11-14' },
    { personId: 'p4', name: 'Lee', label: 'Anniversary', on: '2026-12-20' },
  ];

  it('Reach out moves through its people in order, with its place', () => {
    const s = state({ reachOut: people });
    expect(reachOutKey(s, 0)).toMatchObject({ personId: 'p1', view: { badge: '1/2' } });
    expect(reachOutKey(s, 1)).toMatchObject({ personId: 'p3', index: 1, view: { title: 'Ann', badge: '2/2' } });
    expect(reachOutKey(s, 2).personId).toBe('p1');
  });

  it('Coming up moves through its dates, rose within a week and slate further off', () => {
    const s = state({ comingUp: dates });
    expect(comingUpKey(s, NOW, 0)).toMatchObject({ personId: 'p2', view: { accent: ROSE, badge: '1/2', sub: 'Birthday, tomorrow' } });
    expect(comingUpKey(s, NOW, 1)).toMatchObject({ personId: 'p4', view: { accent: SLATE, sub: 'Anniversary, in 37d' } });
    expect(ROSE).not.toBe('#f472b6');
  });

  it('Pinned moves through the pinned chores in the app\'s order', () => {
    const s = state({
      chores: [chore('water', { pinned: true, ratio: 0.2 }), chore('dust', { pinned: true, ratio: 0.9 }), chore('wipe')],
      pinned: ['dust', 'water'],
    });
    expect(pinnedKey(s, 0, NOW)).toMatchObject({ choreId: 'dust', count: 2, view: { badge: '1/2' } });
    expect(pinnedKey(s, 1, NOW).choreId).toBe('water');
    expect(pinnedKey(state({ pinned: [] }), 0, NOW)).toMatchObject({ choreId: null, view: { sub: 'Nothing pinned' } });
    // An app from before the pinned list: the pinned chores, most overdue first.
    const older = state({ chores: [chore('water', { pinned: true, ratio: 0.2 }), chore('dust', { pinned: true, ratio: 0.9 })] });
    expect(pinnedKey(older, 0, NOW).choreId).toBe('dust');
  });
});

describe('the words', () => {
  it('say since and due as the app works them out, shortened', () => {
    const c = (over: Partial<DeckChore>) => chore('x', over);
    expect([
      { kind: 'never' }, { kind: 'just_now' }, { kind: 'minutes', count: 5 }, { kind: 'hours', count: 3 }, { kind: 'yesterday' }, { kind: 'days', count: 4 },
    ].map((since) => sinceText(c({ since: since as DeckChore['since'] }), NOW))).toEqual(['never', 'just now', '5m ago', '3h ago', 'yesterday', '4d ago']);
    expect([
      { kind: 'none' }, { kind: 'now' }, { kind: 'today' }, { kind: 'tomorrow' }, { kind: 'days', count: 3 },
    ].map((nextDue) => dueText(c({ nextDue: nextDue as DeckChore['nextDue'] })))).toEqual([null, 'due now', 'due today', 'due tomorrow', 'due in 3d']);
    // From an app that sends neither: the old whole-day reckoning, and nothing to turn to.
    expect(sinceText(c({}), NOW)).toBe('2d ago');
    expect(dueText(c({}))).toBeNull();
  });

  it('say how long since in a few characters', () => {
    const ago = (d: number) => new Date(NOW - d * DAY).toISOString();
    expect([null, ago(0.5), ago(1), ago(13), ago(20), ago(90)].map((x) => sinceLabel(x, NOW))).toEqual(['never', 'today', '1d', '13d', '2w', '3mo']);
    expect(daysUntil('2026-11-20', NOW)).toBe(7);
    expect(daysUntil('2026-11-13', NOW)).toBe(0);
  });

  it('shorten on a word where one is near', () => {
    expect(fit('Water plants', 12)).toBe('Water plants');
    expect(fit('Clean the gutters', 12)).toBe('Clean the…');
    expect(fit('Supercalifragilistic', 8)).toBe('Superca…');
  });
});
