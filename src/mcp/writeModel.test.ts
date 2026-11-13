import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/client'
import { createCategory, createChore, logCompletion } from '@/db/queries'
import { handleMcpWrite, type UndoOp, type WriteContext, type WriteResult } from './writeModel'

// The MCP write model against a real (in-memory) database: each write through
// the data layer the forms use, the rules the forms apply, and each undo
// putting things back, or declining to when the user has added to them since.

function installLocalStorage(): void {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  } as Storage
}
installLocalStorage()

const NOW = new Date('2026-11-13T18:00:00.000Z')
let ctx: WriteContext & { changed: ReturnType<typeof vi.fn<() => void>>; activity: ReturnType<typeof vi.fn<(message: string) => void>> }
let home: number
let kitchen: number

beforeEach(async () => {
  await Promise.all([db.categories.clear(), db.chores.clear(), db.completionEvents.clear(), db.tombstones.clear(), db.users.clear()])
  await db.users.bulkAdd([
    { name: 'Alex', sync_id: 'u-alex', updated_at: NOW.toISOString() },
    { name: 'Sam', sync_id: 'u-sam', updated_at: NOW.toISOString() },
  ] as never)
  home = await createCategory('Home', undefined, 'House', undefined, [], 'c-home')
  kitchen = await createCategory('Kitchen', undefined, 'CookingPot', home, ['u-sam'], 'c-kitchen')
  ctx = { meUserSyncId: 'u-alex', now: () => NOW, changed: vi.fn<() => void>(), activity: vi.fn<(message: string) => void>() }
})

type Ok = Extract<WriteResult, { ok: true }>
type Row = { [key: string]: unknown }
const write = async (method: string, params: Record<string, unknown>): Promise<Ok> => {
  const r = await handleMcpWrite(method, params, ctx)
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`)
  return r
}
const refused = async (method: string, params: Record<string, unknown>) => {
  const r = await handleMcpWrite(method, params, ctx)
  if (r.ok) throw new Error('expected a refusal')
  return r.error
}
const undo = (...ops: UndoOp[]) => write('undo_mcp_writes', { ops })
const chore = (r: Ok) => r.data.chore as Row
const choreRow = (syncId: string) => db.chores.where('sync_id').equals(syncId).first()

describe('creating a chore', () => {
  it('saves through the data layer with the form\'s defaults: the category\'s icon and assignees', async () => {
    const r = await write('create_chore', { new_id: 'n-1', name: '  Wipe counters ', category_id: 'c-kitchen', cadence_days: 2 })
    expect(chore(r)).toMatchObject({ id: 'n-1', name: 'Wipe counters', icon: 'CookingPot', category_path: 'Home › Kitchen', cadence_days: 2, assignee_ids: ['u-sam'], pinned: false })
    expect(r.undo).toEqual({ summary: 'Created “Wipe counters”', op: { kind: 'remove_created_chore', choreId: 'n-1' } })
    expect(await choreRow('n-1')).toMatchObject({ category_sync_id: 'c-kitchen', preferred_schedule_behavior: null, seasonal_start: null })
    expect(ctx.changed).toHaveBeenCalled()
    expect(ctx.activity).toHaveBeenCalledWith('Created "Wipe counters" via MCP')
  })

  it('goes to the Inbox with no category, as an undirected add does', async () => {
    const r = await write('create_chore', { new_id: 'n-2', name: 'Call the plumber' })
    expect(chore(r).category_path).toBe('Inbox')
  })

  it('is a replay for an id already stored, and the chore already there for the same name', async () => {
    await write('create_chore', { new_id: 'n-1', name: 'Dust', category_id: 'c-home' })
    const again = await write('create_chore', { new_id: 'n-1', name: 'Dust', category_id: 'c-home' })
    expect(again.data.replayed).toBe(true)
    expect(again.undo).toBeUndefined()
    const same = await write('create_chore', { new_id: 'n-9', name: 'dust ', category_id: 'c-home' })
    expect(same.data.already_existed).toBe(true)
    expect(same.undo).toBeUndefined()
    expect(await db.chores.count()).toBe(1)
  })

  it('takes every field the form edits, and a position', async () => {
    await createChore({ name: 'First', category_id: home, target_cadence_days: null, notify_when_overdue: false, auto_schedule_to_dayglance: false, preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, details: null, assigned_user_sync_ids: [] })
    const r = await write('create_chore', {
      new_id: 'n-3', name: 'Mow lawn', category_id: 'c-home', cadence_days: 7, icon: 'Leaf', details: 'Front and back', pinned: true,
      notify_when_overdue: true, auto_schedule_to_dayglance: true, season: { start: '04-01', end: '10-31' }, assignee_ids: ['u-alex'], position: 0,
    })
    expect(chore(r)).toMatchObject({ icon: 'Leaf', details: 'Front and back', pinned: true, notify_when_overdue: true, auto_schedule_to_dayglance: true, seasonal_start: '04-01', seasonal_end: '10-31', assignee_ids: ['u-alex'] })
    const order = (await db.chores.where('category_id').equals(home).sortBy('sort_order')).map(c => c.name)
    expect(order).toEqual(['Mow lawn', 'First'])
  })

  it('refuses what the form would not save, before writing anything', async () => {
    for (const [params, code] of [
      [{ name: '  ' }, 'validation'],
      [{ name: 'x', cadence_days: 0 }, 'validation'],
      [{ name: 'x', cadence_days: 1.5 }, 'validation'],
      [{ name: 'x', icon: 'NotAnIcon' }, 'validation'],
      [{ name: 'x', season: { start: '02-30', end: '03-01' } }, 'validation'],
      [{ name: 'x', season: { start: '04-01' } }, 'validation'],
      [{ name: 'x', details: 'y'.repeat(2001) }, 'validation'],
      [{ name: 'x', assignee_ids: ['u-nobody'] }, 'not_found'],
      [{ name: 'x', category_id: 'c-gone' }, 'not_found'],
    ] as const) {
      expect((await refused('create_chore', { new_id: 'n-x', ...params })).code, JSON.stringify(params)).toBe(code)
    }
    expect(await db.chores.count()).toBe(0)
  })

  it('undoes by removing it, unless it has been done since', async () => {
    const r = await write('create_chore', { new_id: 'n-1', name: 'Dust', category_id: 'c-home' })
    expect((await undo(r.undo!.op)).data).toEqual({ undone: 1, skipped: [] })
    expect(await choreRow('n-1')).toBeUndefined()
    expect(await db.tombstones.get('n-1')).toBeTruthy()

    const kept = await write('create_chore', { new_id: 'n-2', name: 'Dust again', category_id: 'c-home' })
    await logCompletion((await choreRow('n-2'))!.id)
    expect((await undo(kept.undo!.op)).data).toEqual({ undone: 0, skipped: [{ kind: 'remove_created_chore', reason: 'the chore has been done since, so it was kept' }] })
    expect(await choreRow('n-2')).toBeTruthy()
  })
})

describe('editing a chore', () => {
  beforeEach(async () => {
    await write('create_chore', { new_id: 'ch', name: 'Water plants', category_id: 'c-home', cadence_days: 7, icon: 'Sprout' })
  })

  it('changes only the fields named, and undoes exactly those', async () => {
    const r = await write('update_chore', { chore_id: 'ch', fields: { name: 'Water the ferns', cadence_days: null, icon: null, category_id: 'c-kitchen', season: { start: '11-01', end: '02-28' } } })
    expect(chore(r)).toMatchObject({ name: 'Water the ferns', cadence_days: null, icon: null, category_id: 'c-kitchen', seasonal_start: '11-01', state: 'none' })
    expect(chore(r).assignee_ids).toEqual([])   // a move never re-inherits assignees, as in the app
    expect(r.undo!.op).toMatchObject({ kind: 'restore_chore_fields', before: { name: 'Water plants', cadence_days: 7, icon: 'Sprout', category_id: 'c-home', season: null } })
    await undo(r.undo!.op)
    expect(await choreRow('ch')).toMatchObject({ name: 'Water plants', target_cadence_days: 7, icon: 'Sprout', category_sync_id: 'c-home', seasonal_start: null, seasonal_end: null })
  })

  it('moves to a position, and the undo puts the order back', async () => {
    await write('create_chore', { new_id: 'ch2', name: 'Dust', category_id: 'c-home' })
    await write('create_chore', { new_id: 'ch3', name: 'Sweep', category_id: 'c-home' })
    const names = async () => (await db.chores.where('category_id').equals(home).sortBy('sort_order')).map(c => c.name)
    expect(await names()).toEqual(['Water plants', 'Dust', 'Sweep'])
    const r = await write('update_chore', { chore_id: 'ch3', position: 0 })
    expect(await names()).toEqual(['Sweep', 'Water plants', 'Dust'])
    await undo(r.undo!.op)
    expect(await names()).toEqual(['Water plants', 'Dust', 'Sweep'])
  })

  it('needs something to change, and a chore that exists', async () => {
    expect((await refused('update_chore', { chore_id: 'ch', fields: {} })).code).toBe('validation')
    expect((await refused('update_chore', { chore_id: 'ch-gone', fields: { name: 'x' } })).code).toBe('not_found')
    expect((await refused('update_chore', { chore_id: 'ch', fields: { name: 'x', cadence_days: -1 } })).code).toBe('validation')
    expect((await choreRow('ch'))!.name).toBe('Water plants')   // nothing half-applied
  })
})

describe('completions', () => {
  beforeEach(async () => {
    await write('create_chore', { new_id: 'ch', name: 'Water plants', category_id: 'c-home', cadence_days: 7 })
  })

  it('marks a chore done as the device\'s Me, now or backdated, never in the future', async () => {
    const r = await write('complete_chore', { chore_id: 'ch', new_id: 'e-1', note: ' Ferns too ' })
    expect(r.data.completion).toEqual({ id: 'e-1', completed_at: expect.any(String), note: 'Ferns too' })
    expect(chore(r)).toMatchObject({ state: 'fresh', completions_total: 1 })
    expect(await db.completionEvents.where('sync_id').equals('e-1').first()).toMatchObject({ completed_by_user_sync_id: 'u-alex', source: 'manual' })
    const back = await write('complete_chore', { chore_id: 'ch', new_id: 'e-2', completed_at: '2026-11-10T09:30:00-07:00' })
    expect((back.data.completion as Row).completed_at).toBe('2026-11-10T16:30:00.000Z')
    expect((await refused('complete_chore', { chore_id: 'ch', new_id: 'e-3', completed_at: '2026-11-14T09:00:00Z' })).code).toBe('validation')
    expect((await write('complete_chore', { chore_id: 'ch', new_id: 'e-1' })).data.replayed).toBe(true)
    expect(await db.completionEvents.count()).toBe(2)
  })

  it('undoes a completion by removing it', async () => {
    const r = await write('complete_chore', { chore_id: 'ch', new_id: 'e-1' })
    expect(r.undo).toEqual({ summary: 'Marked “Water plants” done', op: { kind: 'remove_completion', completionId: 'e-1', choreId: 'ch' } })
    await undo(r.undo!.op)
    expect(await db.completionEvents.count()).toBe(0)
  })

  it('edits only the note, and the undo puts the old note back', async () => {
    await write('complete_chore', { chore_id: 'ch', new_id: 'e-1', note: 'first' })
    const r = await write('update_completion', { completion_id: 'e-1', note: 'second' })
    expect(r.data.completion).toMatchObject({ id: 'e-1', note: 'second' })
    await undo(r.undo!.op)
    expect((await db.completionEvents.where('sync_id').equals('e-1').first())!.note).toBe('first')
    expect((await refused('update_completion', { completion_id: 'e-gone', note: 'x' })).code).toBe('not_found')
  })
})

describe('categories', () => {
  it('creates one, a subcategory taking its parent\'s icon but not its assignees', async () => {
    const r = await write('create_category', { new_id: 'c-pantry', name: 'Pantry', parent_id: 'c-home' })
    expect(r.data.category).toMatchObject({ id: 'c-pantry', name: 'Pantry', icon: 'House', parent_id: 'c-home', path: 'Home › Pantry', assignee_ids: [] })
    expect((await refused('create_category', { new_id: 'c-x', name: 'Deep', parent_id: 'c-kitchen' })).code).toBe('validation')
    expect((await write('create_category', { new_id: 'c-pantry', name: 'Pantry' })).data.replayed).toBe(true)
  })

  it('undoes a create only while the category is still empty', async () => {
    const r = await write('create_category', { new_id: 'c-garage', name: 'Garage' })
    await write('create_chore', { new_id: 'ch', name: 'Sweep', category_id: 'c-garage' })
    expect((await undo(r.undo!.op)).data).toMatchObject({ undone: 0, skipped: [{ reason: 'the category has chores in it now, so it was kept' }] })
    await undo({ kind: 'remove_created_chore', choreId: 'ch' }, r.undo!.op)   // newest first, as main sends them
    expect(await db.categories.where('sync_id').equals('c-garage').first()).toBeUndefined()
  })

  it('edits and re-parents, lifting the subcategories as the app does, and the undo puts them back', async () => {
    const garden = await write('create_category', { new_id: 'c-garden', name: 'Garden' })
    const r = await write('update_category', { category_id: 'c-home', fields: { name: 'House', parent_id: 'c-garden', assignee_ids: ['u-alex'] } })
    expect(r.data.category).toMatchObject({ name: 'House', parent_id: 'c-garden', assignee_ids: ['u-alex'] })
    expect((await db.categories.get(kitchen))!.parent_sync_id).toBe('c-garden')   // lifted beside it
    await undo(r.undo!.op)
    expect(await db.categories.get(home)).toMatchObject({ name: 'Home', parent_sync_id: null, assigned_user_sync_ids: [] })
    expect((await db.categories.get(kitchen))!.parent_sync_id).toBe('c-home')
    expect(garden.undo!.op.kind).toBe('remove_created_category')
  })
})
