import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/client'
import { createCircle, createPerson, logInteraction } from '@/people/queries'
import { uuidRe } from '@/people/sync/types'
import { handleMcpWrite, type UndoOp, type WriteContext, type WriteResult } from './writeModel'

// The People write model against a real (in-memory) database: each write
// through the People data layer, the People forms' rules, this user's People
// only, and each undo putting things back or declining to.

const store = new Map<string, string>()
;(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)) },
  removeItem: (k: string) => { store.delete(k) },
  clear: () => { store.clear() },
  key: (i: number) => Array.from(store.keys())[i] ?? null,
  get length() { return store.size },
} as Storage

const NOW = new Date()
let ctx: WriteContext

beforeEach(async () => {
  await Promise.all([db.people.clear(), db.interactions.clear(), db.personDates.clear(), db.personCircles.clear(), db.peopleTombstones.clear()])
  ctx = { meUserSyncId: null, multiUserEnabled: false, now: () => NOW, changed: vi.fn(), activity: vi.fn() }
})

type Ok = Extract<WriteResult, { ok: true }>
type Row = { [key: string]: unknown }
const write = async (method: string, params: Row): Promise<Ok> => {
  const r = await handleMcpWrite(method, params, ctx)
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r
}
const refused = async (method: string, params: Row) => {
  const r = await handleMcpWrite(method, params, ctx)
  if (r.ok) throw new Error('expected a refusal')
  return r.error
}
const undo = (...ops: UndoOp[]) => write('undo_mcp_writes', { ops })
const person = (r: Ok) => r.data.person as Row
const personRow = (id: string) => db.people.where('sync_id').equals(id).first()

describe('people', () => {
  it('adds a person with their dates, through the data layer, with sync-valid ids', async () => {
    const r = await write('create_person', {
      new_id: 'p-maya', name: ' Maya Chen ', nickname: 'May', cadence_days: 14, preferred_channel: 'call',
      dates: [{ kind: 'birthday', month: 11, day: 20, year: 1990, remind_days_before: 1 }, { kind: 'custom', label: 'Moved here', month: 2, day: 29 }],
    })
    expect(person(r)).toMatchObject({ id: 'p-maya', name: 'Maya Chen', nickname: 'May', cadence_days: 14, preferred_channel: 'call', archived: false })
    const dates = person(r).dates as Row[]
    expect(dates.map(d => [d.kind, d.label, d.month, d.day])).toEqual([['birthday', null, 11, 20], ['custom', 'Moved here', 2, 29]])
    for (const d of dates) expect(d.id).toMatch(uuidRe)
    expect(r.undo!.op).toEqual({ kind: 'remove_created_person', personId: 'p-maya', dateIds: dates.map(d => d.id) })
    expect(await personRow('p-maya')).toMatchObject({ owner_user_sync_id: null })
    expect((await write('create_person', { new_id: 'p-maya', name: 'Maya Chen' })).data.replayed).toBe(true)
    expect(await db.people.count()).toBe(1)
  })

  it('refuses what the person form would not save, before writing anything', async () => {
    for (const [params, code] of [
      [{ name: ' ' }, 'validation'],
      [{ name: 'x', cadence_days: 0 }, 'validation'],
      [{ name: 'x', preferred_channel: 'pigeon' }, 'validation'],
      [{ name: 'x', circle_id: 'k-gone' }, 'not_found'],
      [{ name: 'x', archived: true }, 'validation'],
      [{ name: 'x', dates: [{ month: 2, day: 30 }] }, 'validation'],
      [{ name: 'x', dates: [{ month: 1, day: 1, remind_days_before: 5 }] }, 'validation'],
      [{ name: 'x', dates: [{ month: 1, day: 1, year: 0 }] }, 'validation'],
    ] as const) {
      expect((await refused('create_person', { new_id: 'p-x', ...params })).code, JSON.stringify(params)).toBe(code)
    }
    expect(await db.people.count()).toBe(0)
  })

  it('edits, archives and snoozes as the app does, and the undo puts every field back', async () => {
    await write('create_person', { new_id: 'p-sam', name: 'Sam', cadence_days: 7 })
    const r = await write('update_person', { person_id: 'p-sam', fields: { name: 'Sam Ortiz', cadence_days: null, archived: true, snooze_days: 7 } })
    expect(person(r)).toMatchObject({ name: 'Sam Ortiz', cadence_days: null, archived: true })
    expect(Date.parse((await personRow('p-sam'))!.snoozed_until!)).toBeGreaterThan(NOW.getTime() + 6.9 * 86_400_000)
    expect(r.undo!.op).toMatchObject({ kind: 'restore_person_fields', before: { name: 'Sam', cadence_days: 7, archived: false, snoozed_until: null } })
    await undo(r.undo!.op)
    expect(await personRow('p-sam')).toMatchObject({ name: 'Sam', target_cadence_days: 7, archived: false, snoozed_until: null })
    expect((await refused('update_person', { person_id: 'p-sam', fields: { snooze_days: 5 } })).code).toBe('validation')
    expect((await refused('update_person', { person_id: 'p-sam', fields: {} })).code).toBe('validation')
  })

  it('never touches another household member\'s People', async () => {
    await createPerson({ name: 'Private', sync_id: 'p-private' })
    await db.people.where('sync_id').equals('p-private').modify({ owner_user_sync_id: 'u-sam' })
    ctx = { ...ctx, multiUserEnabled: true, meUserSyncId: 'u-alex' }
    expect((await refused('update_person', { person_id: 'p-private', fields: { name: 'x' } })).code).toBe('not_found')
    expect((await refused('log_interaction', { new_id: 'i-1', person_ids: ['p-private'] })).code).toBe('not_found')
    expect((await refused('add_person_date', { new_id: 'd-1', person_id: 'p-private', month: 1, day: 1 })).code).toBe('not_found')
  })

  it('undoes an added person only while nothing has been added for them since', async () => {
    const r = await write('create_person', { new_id: 'p-ann', name: 'Ann', dates: [{ month: 5, day: 5 }] })
    await logInteraction({ person_sync_ids: ['p-ann'], channel: 'call' })
    expect((await undo(r.undo!.op)).data).toEqual({ undone: 0, skipped: [{ kind: 'remove_created_person', reason: 'contacts have been logged with them since, so they were kept' }] })
    const r2 = await write('create_person', { new_id: 'p-bo', name: 'Bo' })
    await write('add_person_date', { new_id: 'd-bo', person_id: 'p-bo', month: 3, day: 3 })
    expect(((await undo(r2.undo!.op)).data.skipped as Row[])[0].reason).toBe('dates have been added for them since, so they were kept')
    const r3 = await write('create_person', { new_id: 'p-cy', name: 'Cy', dates: [{ month: 4, day: 4 }] })
    await undo(r3.undo!.op)
    expect(await personRow('p-cy')).toBeUndefined()
    expect(await db.personDates.where('person_sync_id').equals('p-cy').count()).toBe(0)
  })
})

describe('dates', () => {
  beforeEach(async () => { await write('create_person', { new_id: 'p-maya', name: 'Maya' }) })

  it('adds and edits a date with the form\'s rules, and undoes both', async () => {
    const added = await write('add_person_date', { new_id: 'd-1', person_id: 'p-maya', kind: 'anniversary', label: 'ignored', month: 6, day: 1 })
    expect(await db.personDates.where('sync_id').equals('d-1').first()).toMatchObject({ kind: 'anniversary', label: null, remind_days_before: 0 })
    const edited = await write('update_person_date', { date_id: 'd-1', fields: { kind: 'custom', label: 'First date', day: 2 } })
    expect(await db.personDates.where('sync_id').equals('d-1').first()).toMatchObject({ kind: 'custom', label: 'First date', month: 6, day: 2 })
    expect((await refused('update_person_date', { date_id: 'd-1', fields: { month: 2, day: 30 } })).code).toBe('validation')
    await undo(edited.undo!.op)
    expect(await db.personDates.where('sync_id').equals('d-1').first()).toMatchObject({ kind: 'anniversary', label: null, day: 1 })
    await undo(added.undo!.op)
    expect(await db.personDates.count()).toBe(0)
  })
})

describe('contacts', () => {
  beforeEach(async () => {
    await write('create_person', { new_id: 'p-maya', name: 'Maya', preferred_channel: 'video' })
    await write('create_person', { new_id: 'p-sam', name: 'Sam' })
  })

  it('logs a contact with the suggested channel, ends a snooze, and the undo brings the snooze back', async () => {
    await write('update_person', { person_id: 'p-sam', fields: { snooze_days: 14 } })
    const r = await write('log_interaction', { new_id: 'i-1', person_ids: ['p-maya', 'p-sam'], direction: 'outbound', note: ' Dinner ' })
    expect(r.data.interaction).toMatchObject({ id: 'i-1', channel: 'video', direction: 'outbound', note: 'Dinner', source: 'intent', person_ids: ['p-maya', 'p-sam'] })
    expect((await personRow('p-sam'))!.snoozed_until).toBeNull()
    await undo(r.undo!.op)
    expect(await db.interactions.count()).toBe(0)
    expect((await personRow('p-sam'))!.snoozed_until).not.toBeNull()
    expect((await write('log_interaction', { new_id: 'i-1', person_ids: ['p-maya'] })).undo).toBeDefined()
    expect((await write('log_interaction', { new_id: 'i-1', person_ids: ['p-maya'] })).data.replayed).toBe(true)
  })

  it('refuses an archived person, a future time and an empty list', async () => {
    await write('update_person', { person_id: 'p-sam', fields: { archived: true } })
    expect((await refused('log_interaction', { new_id: 'i-2', person_ids: ['p-sam'] })).code).toBe('validation')
    expect((await refused('log_interaction', { new_id: 'i-2', person_ids: ['p-maya'], occurred_at: new Date(NOW.getTime() + 86_400_000).toISOString() })).code).toBe('validation')
    expect((await refused('log_interaction', { new_id: 'i-2', person_ids: [] })).code).toBe('validation')
    expect((await refused('log_interaction', { new_id: 'i-2', person_ids: ['p-maya'], channel: 'pigeon' })).code).toBe('validation')
  })

  it('edits a contact and undoes it', async () => {
    await write('log_interaction', { new_id: 'i-1', person_ids: ['p-maya'], channel: 'call' })
    const r = await write('update_interaction', { interaction_id: 'i-1', fields: { person_ids: ['p-maya', 'p-sam'], channel: 'text', direction: 'inbound' } })
    expect(r.data.interaction).toMatchObject({ channel: 'text', direction: 'inbound', person_ids: ['p-maya', 'p-sam'] })
    await undo(r.undo!.op)
    expect(await db.interactions.where('sync_id').equals('i-1').first()).toMatchObject({ channel: 'call', direction: null, person_sync_ids: ['p-maya'] })
  })
})

describe('circles', () => {
  it('creates, renames and moves a circle, and undoes; a create with people in it is kept', async () => {
    await createCircle('Family', null, 'k-family')
    const created = await write('create_circle', { new_id: 'k-work', name: 'Work', position: 0 })
    const order = async () => (await db.personCircles.orderBy('sort_order').toArray()).map(c => c.name)
    expect(await order()).toEqual(['Work', 'Family'])
    const edited = await write('update_circle', { circle_id: 'k-work', fields: { name: 'Office' }, position: 5 })
    expect(await order()).toEqual(['Family', 'Office'])
    await undo(edited.undo!.op)
    expect(await order()).toEqual(['Work', 'Family'])
    await write('create_person', { new_id: 'p-x', name: 'X', circle_id: 'k-work' })
    expect(((await undo(created.undo!.op)).data.skipped as Row[])[0].reason).toBe('people have been put in the circle since, so it was kept')
  })
})
