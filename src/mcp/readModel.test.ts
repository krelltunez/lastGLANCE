import { describe, expect, it } from 'vitest'
import { fold, handleMcpRequest, READ_METHODS, readsPeople, type McpResult } from './readModel'
import dayjs from 'dayjs'
import { EVENTS, fixtureData, NOW } from './readModel.fixture'

// Local dates from the fixture's instants, so the suite holds in any zone.
const local = (iso: string | Date) => dayjs(iso).format('YYYY-MM-DD')
const daysUntil = (date: string) => dayjs(date).diff(dayjs(NOW).startOf('day'), 'day')

/** An answer's fields, read loosely in assertions. */
type Row = { [key: string]: unknown }
const rows = (v: unknown) => v as Row[]
const row = (v: unknown) => v as Row

const read = (method: string, params: Record<string, unknown> = {}, data = fixtureData()): Row => {
  const r: McpResult = handleMcpRequest(data, { method, params })
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r.data as Row
}
const refused = (method: string, params: Record<string, unknown> = {}, data = fixtureData()) => {
  const r = handleMcpRequest(data, { method, params })
  if (r.ok) throw new Error('expected a refusal')
  return r.error
}
const ids = (items: unknown) => rows(items).map(i => i.id)

describe('the overview', () => {
  it('counts and lists the due chores, most overdue first, in season only', () => {
    const o = read('overview')
    expect(o.counts).toEqual({ overdue: 1, soon: 2, done_today: EVENTS.filter(e => local(e.completed_at) === local(NOW)).length, chores: 7 })
    expect(ids(o.due)).toEqual(['ch-water', 'ch-vacuum', 'ch-fridge'])   // Mow lawn is overdue but out of season
    expect(rows(o.due)[0]).toMatchObject({ name: 'Water plants', state: 'overdue', ratio: 1.29, category_path: 'Garden', next_due: local(dayjs(EVENTS[0].completed_at).add(7, 'day').toDate()), in_season: true })
    expect(ids(o.pinned)).toEqual(['ch-counters'])
    expect(o).not.toHaveProperty('reach_out')
  })

  it('adds Reach out and Coming up only when asked for People', () => {
    const o = read('overview', { include_people: true })
    expect(rows(o.reach_out).map(p => [p.id, row(p.reason)?.kind])).toEqual([['p-sam', 'date'], ['p-maya', 'date']])
    expect(rows(o.coming_up).map(d => [d.person_name, d.on, d.turning])).toEqual([['Sam Ortiz', '2026-11-15', null], ['Maya Chen', '2026-11-20', 36]])
  })
})

describe('chores', () => {
  it('lists every chore by category path, and filters by state', () => {
    expect(ids(read('list_chores').items)).toEqual(['ch-mow', 'ch-water', 'ch-cafe', 'ch-vacuum', 'ch-fridge', 'ch-kettle', 'ch-counters'])
    expect(ids(read('list_chores', { state: 'due' }).items)).toEqual(['ch-mow', 'ch-water', 'ch-vacuum', 'ch-fridge'])
    expect(ids(read('list_chores', { state: 'none' }).items)).toEqual(['ch-cafe', 'ch-kettle'])
    expect(rows(read('list_chores', { state: 'overdue' }).items).find(c => c.id === 'ch-mow')?.in_season).toBe(false)
  })

  it('takes a category with its subcategories', () => {
    expect(ids(read('list_chores', { category_id: 'c-home' }).items)).toEqual(['ch-cafe', 'ch-vacuum', 'ch-fridge', 'ch-kettle', 'ch-counters'])
    expect(rows(read('list_chores', { category_id: 'c-home' }).items)[2].category_path).toBe('Home › Kitchen')
    expect(refused('list_chores', { category_id: 'nope' }).code).toBe('not_found')
  })

  it('filters by assignee: on the chore or its own category, unassigned, or Mine', () => {
    expect(ids(read('list_chores', { assigned_to: 'u-alex' }).items)).toEqual(['ch-vacuum'])
    expect(ids(read('list_chores', { assigned_to: 'u-sam' }).items)).toEqual(['ch-fridge', 'ch-kettle', 'ch-counters'])
    expect(ids(read('list_chores', { assigned_to: 'unassigned' }).items)).not.toContain('ch-vacuum')
    expect(refused('list_chores', { assigned_to: 'me' }).code).toBe('validation')
    const mine = read('list_chores', { assigned_to: 'me' }, fixtureData({ multiUserEnabled: true, meUserSyncId: 'u-alex' }))
    expect(ids(mine.items)).toEqual(['ch-mow', 'ch-water', 'ch-cafe', 'ch-vacuum'])   // not the Kitchen, which is Sam's
    expect(refused('list_chores', { assigned_to: 'u-nobody' }).code).toBe('not_found')
  })

  it('searches names and categories, accents and case ignored', () => {
    expect(ids(read('list_chores', { query: 'CAFE' }).items)).toEqual(['ch-cafe'])
    expect(ids(read('list_chores', { query: 'kitchen fri' }).items)).toEqual(['ch-fridge'])
    expect(fold('Café Ünïcode')).toBe('cafe unicode')
  })

  it('gives one chore in full, with its recent completions', () => {
    const c = read('get_chore', { chore_id: 'ch-water', completions_limit: 1 })
    expect(c).toMatchObject({ id: 'ch-water', icon: 'Sprout', details: 'The ferns by the window too.', completions_total: 2, notify_when_overdue: false })
    expect(c.completions).toEqual([{ id: 'e-1', completed_at: expect.any(String), note: 'Ferns were dry', source: 'manual', completed_by_user_id: 'u-alex' }])
    expect(rows(read('get_chore', { chore_id: 'ch-water' }).completions)).toHaveLength(2)
    expect(rows(read('get_chore', { chore_id: 'ch-water', completions_limit: 5000 }).completions)).toHaveLength(2)
    expect(refused('get_chore', { chore_id: 'ch-gone' }).code).toBe('not_found')
  })

  it('lists the category tree flat, with paths and counts', () => {
    expect(read('list_categories').items).toEqual([
      { id: 'c-garden', name: 'Garden', icon: null, parent_id: null, path: 'Garden', assignee_ids: [], chore_count: 2, sort_order: 3 },
      { id: 'c-home', name: 'Home', icon: null, parent_id: null, path: 'Home', assignee_ids: [], chore_count: 2, sort_order: 1 },
      { id: 'c-kitchen', name: 'Kitchen', icon: null, parent_id: 'c-home', path: 'Home › Kitchen', assignee_ids: ['u-sam'], chore_count: 3, sort_order: 2 },
    ])
  })

  it('reads the activity in a window, newest first', () => {
    const from = local(dayjs(NOW).subtract(30, 'day').toDate())
    const a = read('activity', { from, to: local(NOW) })
    const expected: Record<string, number> = {}
    for (const e of EVENTS) if (local(e.completed_at) >= from) expected[local(e.completed_at)] = (expected[local(e.completed_at)] ?? 0) + 1
    expect(a.by_day).toEqual(expected)   // the orphaned completion counts; it is not listed below
    expect(rows(a.items).map(i => i.chore_id)).toEqual(['ch-counters', 'ch-vacuum', 'ch-water', 'ch-water', 'ch-mow', 'ch-fridge'])
    expect(refused('activity', { from: '2026-11-13', to: '2026-11-01' }).code).toBe('validation')
  })

  it('lists the users, with who this device is only in multi-user mode', () => {
    expect(read('list_users')).toEqual({ multi_user_enabled: false, me_user_id: null, users: [{ id: 'u-alex', name: 'Alex' }, { id: 'u-sam', name: 'Sam' }] })
    expect(read('list_users', {}, fixtureData({ multiUserEnabled: true, meUserSyncId: 'u-alex' })).me_user_id).toBe('u-alex')
  })
})

describe('People', () => {
  it('lists people by name, without the archived unless asked', () => {
    expect(ids(read('list_people').items)).toEqual(['p-maya', 'p-sam'])
    expect(ids(read('list_people', { include_archived: true }).items)).toEqual(['p-ann', 'p-maya', 'p-sam'])
    expect(ids(read('list_people', { circle_id: 'k-friends' }).items)).toEqual(['p-maya'])
    expect(ids(read('list_people', { circle_id: 'none' }).items)).toEqual(['p-sam'])
    expect(ids(read('list_people', { query: 'ortiz' }).items)).toEqual(['p-sam'])
    expect(refused('list_people', { circle_id: 'k-gone' }).code).toBe('not_found')
  })

  it('never shows another household member\'s People, as the People screens do not', () => {
    const asAlex = fixtureData({ multiUserEnabled: true, meUserSyncId: 'u-alex' })
    expect(ids(read('list_people', {}, asAlex).items)).toEqual(['p-maya'])
    expect(refused('get_person', { person_id: 'p-sam' }, asAlex).code).toBe('not_found')
    expect(rows(read('upcoming_dates', {}, asAlex).items).map(d => d.person_id)).toEqual(['p-maya'])
    expect(ids(read('overview', { include_people: true }, asAlex).reach_out)).toEqual(['p-maya'])
    expect(read('list_circles', {}, asAlex).items).toEqual([{ id: 'k-friends', name: 'Friends', icon: null, people_count: 1 }])
  })

  it('gives one person in full, with their dates and recent contacts', () => {
    const p = read('get_person', { person_id: 'p-maya' })
    expect(p).toMatchObject({ name: 'Maya Chen', circle_name: 'Friends', cadence_days: 14, ratio: 1.43, details: 'Loves hiking.', interactions_total: 1 })
    expect(p.dates).toEqual([{ id: 'd-maya-bday', kind: 'birthday', label: null, month: 11, day: 20, year: 1990, remind_days_before: 1, next_on: '2026-11-20', days_until: daysUntil('2026-11-20') }])
    expect(rows(p.interactions)[0]).toMatchObject({ id: 'i-1', channel: 'call', direction: 'outbound', note: 'Talked about the trip', person_ids: ['p-maya'] })
    expect(read('get_person', { person_id: 'p-sam' }).reciprocity).toEqual({ unreturned: true, outbound_in_a_row: 0 })
  })

  it('lists upcoming dates in a window', () => {
    expect(ids(read('upcoming_dates', { days: 3 }).items)).toEqual(['d-sam-bday'])
    expect(refused('upcoming_dates', { days: 400 }).code).toBe('validation')
  })
})

describe('requests', () => {
  it('refuses a method it does not know, and knows which methods read People', () => {
    expect(refused('delete_everything').code).toBe('validation')
    expect(READ_METHODS.filter(readsPeople)).toEqual(['overview', 'list_people', 'get_person', 'upcoming_dates', 'list_circles'])
  })
})
