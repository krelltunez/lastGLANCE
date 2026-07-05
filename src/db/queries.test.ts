import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from './client'
import {
  createCategory,
  createChore,
  updateCategory,
  getCategories,
  exportBackup,
  restoreFromBackup,
} from './queries'
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
    expect(counts).toEqual({ categories: 1, chores: 1, completionEvents: 1 })

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
