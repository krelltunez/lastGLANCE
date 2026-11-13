import dayjs from 'dayjs'
import type { Category, Chore, CompletionEvent, User } from '@/types'
import type { Interaction, Person, PersonCircle, PersonDate, PersonWithLastInteraction } from '@/people/types'
import { reciprocitySignals } from '@/people/reciprocity'
import type { McpReadData } from './readModel'

// A small household for the MCP read model's tests and the transport suite
// (electron/mcpServer.transport.test.ts). Noon UTC, so a local date is the
// same in any zone a test machine runs in.

export const NOW = new Date('2026-11-13T12:00:00.000Z')
const ago = (days: number) => dayjs(NOW).subtract(days, 'day').toISOString()

export const USERS: User[] = [
  { id: 1, name: 'Alex', sync_id: 'u-alex', updated_at: ago(100) },
  { id: 2, name: 'Sam', sync_id: 'u-sam', updated_at: ago(100) },
]

const cat = (id: number, sync: string, name: string, parent: number | null, assigned: string[] = []): Category => ({
  id, name, sort_order: id, sync_id: sync, parent_sync_id: null, updated_at: ago(100), assigned_user_sync_ids: assigned,
  ...(parent !== null && { parent_category_id: parent }),
})

export const CATEGORIES: Category[] = [
  cat(1, 'c-home', 'Home', null),
  cat(2, 'c-kitchen', 'Kitchen', 1, ['u-sam']),
  cat(3, 'c-garden', 'Garden', null),
]

const chore = (id: number, sync: string, name: string, category: number, cadence: number | null, over: Partial<Chore> = {}): Chore => ({
  id, name, category_id: category, sort_order: id, target_cadence_days: cadence, notify_when_overdue: false,
  auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null,
  details: null, pinned: false, created_at: ago(200), updated_at: ago(200), sync_id: sync, category_sync_id: null,
  assigned_user_sync_ids: [], ...over,
})

export const CHORES: Chore[] = [
  chore(1, 'ch-water', 'Water plants', 3, 7, { icon: 'Sprout', details: 'The ferns by the window too.' }),
  chore(2, 'ch-fridge', 'Clean fridge', 2, 30),
  chore(3, 'ch-counters', 'Wipe counters', 2, 2, { pinned: true }),
  chore(4, 'ch-kettle', 'Descale kettle', 2, null),
  chore(5, 'ch-mow', 'Mow lawn', 3, 7, { seasonal_start: '04-01', seasonal_end: '10-31' }),
  chore(6, 'ch-vacuum', 'Vacuum', 1, 7, { assigned_user_sync_ids: ['u-alex'] }),
  chore(7, 'ch-cafe', 'Café run', 1, null),
]

const event = (id: number, choreId: number, daysAgo: number, over: Partial<CompletionEvent> = {}): CompletionEvent => ({
  id, chore_id: choreId, completed_at: ago(daysAgo), note: null, source: 'manual', completed_by_user_sync_id: null,
  sync_id: `e-${id}`, ...over,
})

export const EVENTS: CompletionEvent[] = [
  event(1, 1, 9, { note: 'Ferns were dry', completed_by_user_sync_id: 'u-alex' }),
  event(2, 1, 16),
  event(3, 2, 25),
  event(4, 3, 0.05),
  event(5, 5, 20),
  event(6, 6, 6),
  event(7, 99, 1), // a completion whose chore is gone: counted in by_day, not listed
]

export const CIRCLES: PersonCircle[] = [
  { id: 1, sync_id: 'k-friends', name: 'Friends', icon: null, sort_order: 0, updated_at: ago(100) },
]

const person = (sync: string, name: string, over: Partial<Person> = {}): Person => ({
  sync_id: sync, name, nickname: null, circle_sync_id: null, target_cadence_days: null, preferred_channel: null,
  details: null, archived: false, snoozed_until: null, owner_user_sync_id: null, created_at: ago(300), updated_at: ago(300),
  ...over,
})

const PEOPLE_ROWS: Person[] = [
  person('p-maya', 'Maya Chen', { circle_sync_id: 'k-friends', target_cadence_days: 14, preferred_channel: 'call', details: 'Loves hiking.' }),
  person('p-sam', 'Sam Ortiz', { owner_user_sync_id: 'u-sam', target_cadence_days: 7 }),
  person('p-ann', 'Ann Lee', { archived: true }),
]

export const INTERACTIONS: Interaction[] = [
  { sync_id: 'i-1', person_sync_ids: ['p-maya'], occurred_at: ago(20), channel: 'call', direction: 'outbound', note: 'Talked about the trip', source: 'manual', updated_at: ago(20) },
  { sync_id: 'i-2', person_sync_ids: ['p-sam'], occurred_at: ago(3), channel: 'text', direction: 'inbound', note: null, source: 'manual', updated_at: ago(3) },
]

export const DATES: PersonDate[] = [
  { sync_id: 'd-maya-bday', person_sync_id: 'p-maya', kind: 'birthday', label: null, month: 11, day: 20, year: 1990, remind_days_before: 1, updated_at: ago(100) },
  { sync_id: 'd-sam-bday', person_sync_id: 'p-sam', kind: 'birthday', label: null, month: 11, day: 15, year: null, remind_days_before: 0, updated_at: ago(100) },
]

/** People with their recency, as getPeople computes it. */
export function peopleWithRecency(): PersonWithLastInteraction[] {
  const now = dayjs(NOW)
  return PEOPLE_ROWS.map(p => {
    const mine = INTERACTIONS.filter(i => i.person_sync_ids.includes(p.sync_id))
    const last = [...mine].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))[0] ?? null
    const since = last ? last.occurred_at : p.created_at
    return {
      ...p,
      last_interaction_at: last?.occurred_at ?? null,
      last_channel: last?.channel ?? null,
      last_direction: last?.direction ?? null,
      elapsed_days: Math.round(now.diff(dayjs(since), 'minute') / (60 * 24) * 10) / 10,
      reciprocity: reciprocitySignals(mine, now),
    }
  })
}

export function fixtureData(over: Partial<McpReadData> = {}): McpReadData {
  return {
    now: NOW,
    categories: CATEGORIES,
    chores: CHORES,
    events: EVENTS,
    users: USERS,
    multiUserEnabled: false,
    meUserSyncId: null,
    people: peopleWithRecency(),
    interactions: INTERACTIONS,
    dates: DATES,
    circles: CIRCLES,
    showReciprocity: true,
    ...over,
  }
}
