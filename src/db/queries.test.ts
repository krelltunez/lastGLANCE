import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from './client'
import {
  createCategory,
  createChore,
  updateCategory,
  updateChore,
  CHORE_DETAILS_MAX_LENGTH,
  getCategories,
  exportBackup,
  restoreFromBackup,
  logCompletion,
  getJournalEntries,
  ensureInboxCategory,
} from './queries'
import dayjs from 'dayjs'
import type { Chore, CompletionEvent } from '@/types'

// markDirty/markDeleted are no-ops without a registered DB engine (see
// dirtyTracker), and window is guarded, so these run cleanly under node.

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

async function wipe(): Promise<void> {
  await Promise.all([
    db.categories.clear(),
    db.chores.clear(),
    db.completionEvents.clear(),
    db.tombstones.clear(),
    db.users.clear(),
  ])
}

beforeEach(wipe)

describe('#191 — re-parenting a category with subcategories', () => {
  it('lifts the moved category’s subcategories up to the destination so nothing nests 3 deep', async () => {
    // A (root) contains subcategory S (with a chore). B is another root.
    const aId = await createCategory('A')
    const bId = await createCategory('B')
    const sId = await createCategory('S', undefined, undefined, aId)
    await createChore({
      name: 'Water plants', category_id: sId, target_cadence_days: 7,
      notify_when_overdue: false, auto_schedule_to_dayglance: false,
      preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null,
      assigned_user_sync_ids: [],
    } as unknown as Parameters<typeof createChore>[0])

    // Move A under B.
    await updateCategory(aId, { parent_category_id: bId })

    const cats = await getCategories()
    const byId = new Map(cats.map(c => [c.id, c]))
    const a = byId.get(aId)!
    const s = byId.get(sId)!
    const b = byId.get(bId)!

    // A is now a subcategory of B.
    expect(a.parent_category_id).toBe(bId)
    expect(a.parent_sync_id).toBe(b.sync_id)

    // S was lifted to B as well (sibling of A) rather than orphaned 3 levels deep.
    expect(s.parent_category_id).toBe(bId)
    expect(s.parent_sync_id).toBe(b.sync_id)

    // No category ends up nested under something that is itself nested.
    for (const c of cats) {
      if (c.parent_category_id != null) {
        expect(byId.get(c.parent_category_id)!.parent_category_id).toBeUndefined()
      }
    }

    // The chore never moved — it still belongs to S.
    const chore = await db.chores.toArray().then(cs => cs[0])
    expect(chore.category_id).toBe(sId)
  })

  it('un-nesting to root leaves children pointing at the promoted category', async () => {
    const aId = await createCategory('A')
    const bId = await createCategory('B')
    await updateCategory(aId, { parent_category_id: bId }) // A under B
    await updateCategory(aId, { parent_category_id: null }) // A back to root

    const a = (await getCategories()).find(c => c.id === aId)!
    expect(a.parent_category_id).toBeUndefined()
    expect(a.parent_sync_id).toBeNull()
  })
})

describe('#192 — restoreFromBackup', () => {
  async function seed() {
    const catId = await createCategory('Home')
    const choreId = await createChore({
      name: 'Mop', category_id: catId, target_cadence_days: 14,
      notify_when_overdue: false, auto_schedule_to_dayglance: false,
      preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null,
      assigned_user_sync_ids: [],
    } as unknown as Parameters<typeof createChore>[0])
    return { catId, choreId }
  }

  it('restores a snake_case (exportBackup) file and re-stamps updated_at so it wins the sync merge', async () => {
    await seed()
    const backup = await exportBackup()
    const before = backup.chores[0].updated_at

    // Simulate a later local edit, then restore the older backup.
    await db.chores.toCollection().modify(c => { (c as Chore).name = 'Mop — edited' })
    await new Promise(r => setTimeout(r, 5))
    await restoreFromBackup(backup)

    const chores = await db.chores.toArray()
    expect(chores).toHaveLength(1)
    expect(chores[0].name).toBe('Mop') // backup value won
    // updated_at was bumped to "now" (newer than the backup's own timestamp) so a
    // last-writer-wins merge keeps the restored copy rather than the server's.
    expect(chores[0].updated_at > before).toBe(true)
  })

  it('restores a camelCase WebDAV/SyncPayload backup (the format that used to fail import)', async () => {
    const catSync = '00000000-0000-0000-0000-0000000000c1'
    const choreSync = '00000000-0000-0000-0000-0000000000f1'
    const evtSync = '00000000-0000-0000-0000-0000000000e1'
    const syncPayload = {
      categories: [{ id: catSync, name: 'Garden', sortOrder: 0, icon: 'Home', parentId: null, assignedUserSyncIds: [], updatedAt: '2024-01-01T00:00:00.000Z' }],
      chores: [{ id: choreSync, name: 'Prune', categorySyncId: catSync, sortOrder: 0, targetCadenceDays: 30, notifyWhenOverdue: false, autoScheduleToDayglance: false, preferredScheduleBehavior: null, seasonalStart: null, seasonalEnd: null, icon: 'Home', assignedUserSyncIds: [], createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' }],
      completionEvents: [{ id: evtSync, choreSyncId: choreSync, completedAt: '2024-02-01T00:00:00.000Z', note: null, source: 'manual', completedByUserSyncId: null }],
      users: [],
      settings: { multiUserEnabled: false },
      tombstones: {},
    }

    const counts = await restoreFromBackup(syncPayload)
    expect(counts).toEqual({ categories: 1, chores: 1, completionEvents: 1, people: 0, interactions: 0 })

    const cat = (await db.categories.toArray())[0]
    const chore = (await db.chores.toArray())[0]
    const evt = (await db.completionEvents.toArray())[0]
    expect(cat.sync_id).toBe(catSync)
    // Foreign keys were rebuilt from sync_ids.
    expect(chore.category_id).toBe(cat.id)
    expect(chore.category_sync_id).toBe(catSync)
    expect(evt.chore_id).toBe(chore.id)
    // Real history keeps its own timestamp.
    expect(evt.completed_at).toBe('2024-02-01T00:00:00.000Z')
  })

  it('tombstones entities that are absent from the backup', async () => {
    const { catId } = await seed()
    const cat = await db.categories.get(catId)
    const backup = await exportBackup()

    // Add a second category that the backup does not know about.
    const staleId = await createCategory('Temporary')
    const stale = await db.categories.get(staleId)

    await restoreFromBackup(backup)

    // The stale category is gone and tombstoned so the delete propagates on sync.
    expect(await db.categories.get(staleId)).toBeUndefined()
    const tomb = await db.tombstones.get(stale!.sync_id)
    expect(tomb).toBeTruthy()
    // The backup’s own category survives (keyed by its stable sync_id — restore
    // reassigns local numeric ids) and is not tombstoned.
    expect(await db.tombstones.get(cat!.sync_id)).toBeUndefined()
    expect(await db.categories.where('sync_id').equals(cat!.sync_id).first()).toBeTruthy()
  })

  it('does not wipe the user roster when the backup carries no users array (v1 file export)', async () => {
    await seed()
    await db.users.add({ sync_id: '00000000-0000-0000-0000-0000000000a1', name: 'Alex', updated_at: '2024-01-01T00:00:00.000Z' } as never)

    // A v1-style export: categories/chores/events only, no `users` key.
    const legacy = { version: 1, exportedAt: new Date().toISOString(), categories: await db.categories.toArray(), chores: await db.chores.toArray(), completionEvents: [] as CompletionEvent[] }
    await restoreFromBackup(legacy)

    const users = await db.users.toArray()
    expect(users).toHaveLength(1)
    expect(users[0].name).toBe('Alex')
  })

  it('refuses a completely empty backup rather than wiping everything', async () => {
    await seed()
    await expect(
      restoreFromBackup({ categories: [], chores: [], completionEvents: [], users: [] }),
    ).rejects.toThrow(/empty backup/)
    // Data untouched.
    expect(await db.categories.count()).toBe(1)
  })
})

describe('#271 — chore details', () => {
  const DETAILS = 'Tomato feed (fruit, veg)\nAll-purpose (flowers & pots)'

  async function seedWithDetails(details: string | null) {
    const catId = await createCategory('Garden')
    const choreId = await createChore({
      name: 'Garden feeding', category_id: catId, target_cadence_days: 14,
      notify_when_overdue: false, auto_schedule_to_dayglance: false,
      preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null,
      details, assigned_user_sync_ids: [],
    } as unknown as Parameters<typeof createChore>[0])
    return { catId, choreId }
  }

  it('persists details on create and lets an edit rewrite or clear them', async () => {
    const { choreId } = await seedWithDetails(DETAILS)
    expect((await db.chores.get(choreId))!.details).toBe(DETAILS)

    await updateChore(choreId, { details: 'Chilli feed' })
    expect((await db.chores.get(choreId))!.details).toBe('Chilli feed')

    await updateChore(choreId, { details: null })
    expect((await db.chores.get(choreId))!.details).toBeNull()
  })

  it('survives an export → restore round-trip, line breaks and all', async () => {
    await seedWithDetails(DETAILS)
    const backup = await exportBackup()
    expect(backup.chores[0].details).toBe(DETAILS)

    await restoreFromBackup(backup)

    const chores = await db.chores.toArray()
    expect(chores).toHaveLength(1)
    expect(chores[0].details).toBe(DETAILS)
  })

  it('restores a pre-#271 backup whose chores carry no details key as null', async () => {
    await seedWithDetails(null)
    const backup = await exportBackup()
    const legacy = {
      ...backup,
      chores: backup.chores.map(c => {
        const legacyChore: Partial<Chore> = { ...c }
        delete legacyChore.details
        return legacyChore
      }),
    }
    await wipe()

    await restoreFromBackup(legacy)

    expect((await db.chores.toArray())[0].details).toBeNull()
  })

  it('rejects a backup whose details exceed the length cap instead of importing it', async () => {
    await seedWithDetails(null)
    const backup = await exportBackup()
    backup.chores[0].details = 'x'.repeat(CHORE_DETAILS_MAX_LENGTH + 1)

    await expect(restoreFromBackup(backup)).rejects.toThrow(/invalid chore details/)
    // The oversized import was refused before it touched anything.
    expect((await db.chores.toArray())[0].details).toBeNull()
  })
})

describe('getJournalEntries', () => {
  async function addChore(name: string, categoryId: number): Promise<number> {
    return createChore({
      name, category_id: categoryId, target_cadence_days: null,
      notify_when_overdue: false, auto_schedule_to_dayglance: false,
      preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null,
      assigned_user_sync_ids: [],
    } as unknown as Parameters<typeof createChore>[0])
  }

  it('joins each event to its chore and root category, newest first', async () => {
    const homeId = await createCategory('Home')
    const kitchenId = await createCategory('Kitchen', undefined, undefined, homeId)
    const mopId = await addChore('Mop', kitchenId)
    const trashId = await addChore('Trash', homeId)

    await logCompletion(mopId, { completedAt: '2026-03-01T10:00:00.000Z', note: 'front only' })
    await logCompletion(trashId, { completedAt: '2026-03-05T10:00:00.000Z', source: 'dayglance' })

    const entries = await getJournalEntries()

    expect(entries.map(e => e.chore_name)).toEqual(['Trash', 'Mop'])
    // The chore's own category is reported, but the root is what the category
    // filter matches on — so a chore in a subcategory still rolls up to Home.
    const mop = entries.find(e => e.chore_name === 'Mop')!
    expect(mop.category_name).toBe('Kitchen')
    expect(mop.root_category_id).toBe(homeId)
    expect(mop.root_category_name).toBe('Home')
    expect(mop.event.note).toBe('front only')
    expect(entries.find(e => e.chore_name === 'Trash')!.event.source).toBe('dayglance')
  })

  it('honours the exact from/to bounds despite the widened index prefilter', async () => {
    const catId = await createCategory('Home')
    const choreId = await addChore('Mop', catId)

    // One event inside the window, and one on each side within the extra day
    // the index range is widened by — the day-grain padding must not leak them in.
    const from = dayjs('2026-03-10').startOf('day')
    const to = dayjs('2026-03-11').endOf('day')
    await logCompletion(choreId, { completedAt: from.subtract(2, 'hour').toISOString() })
    await logCompletion(choreId, { completedAt: from.add(6, 'hour').toISOString() })
    await logCompletion(choreId, { completedAt: to.add(2, 'hour').toISOString() })

    const entries = await getJournalEntries({ from: from.toISOString(), to: to.toISOString() })

    expect(entries).toHaveLength(1)
    expect(dayjs(entries[0].event.completed_at).isSame(from.add(6, 'hour'))).toBe(true)
  })

  it('supports an open-ended bound', async () => {
    const catId = await createCategory('Home')
    const choreId = await addChore('Mop', catId)
    await logCompletion(choreId, { completedAt: '2026-01-01T10:00:00.000Z' })
    await logCompletion(choreId, { completedAt: '2026-06-01T10:00:00.000Z' })

    expect(await getJournalEntries({ from: '2026-03-01T00:00:00.000Z' })).toHaveLength(1)
    expect(await getJournalEntries({ to: '2026-03-01T00:00:00.000Z' })).toHaveLength(1)
    expect(await getJournalEntries()).toHaveLength(2)
  })

  it('drops events whose chore no longer exists rather than rendering a blank row', async () => {
    const catId = await createCategory('Home')
    const choreId = await addChore('Mop', catId)
    await logCompletion(choreId, { completedAt: '2026-03-01T10:00:00.000Z' })
    // An event that arrived from sync ahead of (or after) its chore.
    await logCompletion(9999, { completedAt: '2026-03-02T10:00:00.000Z' })

    const entries = await getJournalEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].chore_name).toBe('Mop')
  })
})

describe('ensureInboxCategory', () => {
  it('creates the Inbox with its icon the first time one is needed', async () => {
    const { category, created } = await ensureInboxCategory()

    expect(created).toBe(true)
    expect(category.name).toBe('Inbox')
    // The icon is what distinguishes it in the ribbon; the Tasker path used to
    // create this category without one.
    expect(category.icon).toBe('Inbox')
    expect(await db.categories.count()).toBe(1)
  })

  it('reuses the existing Inbox instead of creating a second one', async () => {
    const first = await ensureInboxCategory()
    const second = await ensureInboxCategory()

    expect(second.created).toBe(false)
    expect(second.category.id).toBe(first.category.id)
    expect(await db.categories.count()).toBe(1)
  })

  it('matches an existing Inbox case-insensitively and ignoring surrounding space', async () => {
    const existingId = await createCategory('  inbox ')
    const { category, created } = await ensureInboxCategory()

    expect(created).toBe(false)
    expect(category.id).toBe(existingId)
    expect(await db.categories.count()).toBe(1)
  })

  it('leaves other categories alone', async () => {
    const homeId = await createCategory('Home')
    const { category, created } = await ensureInboxCategory()

    expect(created).toBe(true)
    expect(category.id).not.toBe(homeId)
    const names = (await getCategories()).map(c => c.name).sort()
    expect(names).toEqual(['Home', 'Inbox'])
  })
})
