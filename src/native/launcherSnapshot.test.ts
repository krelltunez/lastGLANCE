import { describe, it, expect } from 'vitest'
import { buildLauncherSnapshot, launcherSnapshotFingerprint, type LauncherSnapshotInput } from './launcherSnapshot'
import type { Category, ChoreWithLastCompletion } from '@/types'
import type { PersonCircle, PersonDate, PersonWithLastInteraction } from '@/people/types'
import { NO_SIGNALS } from '@/people/reciprocity'

const now = new Date('2026-10-19T15:00:00.000Z')

function category(id: number, name: string, assigned: string[] = []): Category {
  return { id, name, sort_order: id, sync_id: `cat-${id}`, parent_sync_id: null, updated_at: '2026-10-01T00:00:00.000Z', assigned_user_sync_ids: assigned }
}

function chore(id: number, name: string, category_id: number, extra: Partial<ChoreWithLastCompletion> = {}): ChoreWithLastCompletion {
  return {
    id, name, category_id, sort_order: id, target_cadence_days: 7, notify_when_overdue: false,
    auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null,
    details: null, pinned: false, created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-02T00:00:00.000Z',
    sync_id: `chore-${id}`, category_sync_id: `cat-${category_id}`, assigned_user_sync_ids: [],
    last_completed_at: '2026-10-15T12:00:00.000Z', elapsed_days: 4.1, ...extra,
  }
}

function person(syncId: string, name: string, extra: Partial<PersonWithLastInteraction> = {}): PersonWithLastInteraction {
  return {
    sync_id: syncId, name, nickname: null, circle_sync_id: 'circle-1', target_cadence_days: 30, preferred_channel: 'call',
    details: null, archived: false, snoozed_until: null, owner_user_sync_id: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-10-03T00:00:00.000Z',
    last_interaction_at: '2026-10-10T18:00:00.000Z', last_channel: 'text', last_direction: 'inbound', elapsed_days: 9,
    reciprocity: { ...NO_SIGNALS, unreturned: true, inbound: 1, lastInitiator: 'inbound' }, ...extra,
  }
}

const circles: PersonCircle[] = [{ sync_id: 'circle-1', name: 'Family', icon: null, sort_order: 0, updated_at: '2026-01-01T00:00:00.000Z' }]
const dates: PersonDate[] = [
  { sync_id: 'd1', person_sync_id: 'p1', kind: 'birthday', label: null, month: 11, day: 2, year: 1986, remind_days_before: 7, updated_at: '2026-01-01T00:00:00.000Z' },
  { sync_id: 'd2', person_sync_id: 'p2', kind: 'custom', label: 'Moved', month: 3, day: 1, year: null, remind_days_before: 0, updated_at: '2026-01-01T00:00:00.000Z' },
]

function input(extra: Partial<LauncherSnapshotInput> = {}): LauncherSnapshotInput {
  return {
    now,
    categories: [category(1, 'Kitchen'), category(2, 'Garden')],
    chores: [chore(1, 'Vacuum', 1), chore(2, 'Mow', 2, { target_cadence_days: null, last_completed_at: null, elapsed_days: null, icon: 'scissors' })],
    people: [person('p1', 'Ana'), person('p2', 'Ben', { reciprocity: NO_SIGNALS, last_interaction_at: null, last_channel: null, snoozed_until: '2026-10-25T00:00:00.000Z' })],
    dates, circles, multiUserEnabled: false, meId: null, handledWrites: [], timezone: 'America/Denver', ...extra,
  }
}

describe('buildLauncherSnapshot', () => {
  it('maps chores by sync id with their category, cadence and last done', () => {
    const snap = buildLauncherSnapshot(input())
    expect(snap.version).toBe(1)
    expect(snap.updatedAt).toBe(now.getTime())
    expect(snap.today).toBe('2026-10-19')
    expect(snap.timezone).toBe('America/Denver')
    expect(snap.chores).toEqual([
      { id: 'chore-1', name: 'Vacuum', category: 'Kitchen', categoryId: 'cat-1', targetCadenceDays: 7, lastDoneAt: '2026-10-15T12:00:00.000Z', elapsedDays: 4.1, icon: null, updatedAt: '2026-10-02T00:00:00.000Z', clientId: null },
      { id: 'chore-2', name: 'Mow', category: 'Garden', categoryId: 'cat-2', targetCadenceDays: null, lastDoneAt: null, elapsedDays: null, icon: 'scissors', updatedAt: '2026-10-02T00:00:00.000Z', clientId: null },
    ])
  })

  it('maps people with their circle, reciprocity, snooze and dates', () => {
    const snap = buildLauncherSnapshot(input())
    expect(snap.people.map(p => p.id)).toEqual(['p1', 'p2'])
    expect(snap.people[0]).toMatchObject({ name: 'Ana', circle: 'Family', circleId: 'circle-1', lastChannel: 'text', unreturned: true, snoozedUntil: null })
    expect(snap.people[0].dates).toEqual([{ id: 'd1', kind: 'birthday', label: null, month: 11, day: 2, year: 1986 }])
    expect(snap.people[1]).toMatchObject({ unreturned: false, lastInteractionAt: null, snoozedUntil: '2026-10-25T00:00:00.000Z' })
    expect(snap.people[1].dates).toEqual([{ id: 'd2', kind: 'custom', label: 'Moved', month: 3, day: 1, year: null }])
  })

  it('leaves out archived people and, with multi-user on, chores and people that are not mine', () => {
    const snap = buildLauncherSnapshot(input({
      multiUserEnabled: true,
      meId: 'me',
      categories: [category(1, 'Kitchen'), category(2, 'Garden', ['someone-else'])],
      chores: [chore(1, 'Vacuum', 1), chore(2, 'Mow', 2), chore(3, 'Dishes', 1, { assigned_user_sync_ids: ['someone-else'] })],
      people: [person('p1', 'Ana'), person('p2', 'Ben', { owner_user_sync_id: 'someone-else' }), person('p3', 'Cy', { archived: true })],
    }))
    expect(snap.chores.map(c => c.id)).toEqual(['chore-1'])
    expect(snap.people.map(p => p.id)).toEqual(['p1'])
  })

  it('joins the launcher client id onto a chore the launcher created, and carries the ledger', () => {
    const handledWrites = [
      { clientId: 'w-create', action: 'create', entityId: 'chore-2', at: '2026-10-19T14:00:00.000Z' },
      { clientId: 'w-done', action: 'complete', entityId: 'chore-1', at: '2026-10-19T14:01:00.000Z' },
    ]
    const snap = buildLauncherSnapshot(input({ handledWrites }))
    expect(snap.chores.find(c => c.id === 'chore-2')?.clientId).toBe('w-create')
    expect(snap.chores.find(c => c.id === 'chore-1')?.clientId).toBeNull()
    expect(snap.handledWrites).toEqual(handledWrites)
  })

  it('skips a chore without a sync id or seen twice', () => {
    const snap = buildLauncherSnapshot(input({ chores: [chore(1, 'Vacuum', 1), chore(1, 'Vacuum', 1), chore(9, 'Ghost', 1, { sync_id: '' })] }))
    expect(snap.chores.map(c => c.id)).toEqual(['chore-1'])
  })

  it('fingerprints the content, not the stamp', () => {
    const a = buildLauncherSnapshot(input())
    const b = buildLauncherSnapshot(input({ now: new Date(now.getTime() + 60_000) }))
    expect(launcherSnapshotFingerprint(a)).toBe(launcherSnapshotFingerprint(b))
    const c = buildLauncherSnapshot(input({ chores: [chore(1, 'Vacuum', 1)] }))
    expect(launcherSnapshotFingerprint(c)).not.toBe(launcherSnapshotFingerprint(a))
  })
})
