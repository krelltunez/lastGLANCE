import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { db } from '@/db/client'
import { restoreFromBackup } from '@/db/queries'
import { buildPayload, mergePayloads, applyPayload } from './engine'
import type { SyncPayload } from './types'

// Issue #337: restoring a backup on one device and syncing wiped it (or the
// other device). Restored rows keep their sync ids and are stamped "now" so
// they win last-writer-wins, and mergePayloads honours that: a row newer than
// its tombstone survives the merge. But applyPayload treated every tombstoned
// id as dead regardless of time, so it deleted the rows the merge had just
// kept. Any older tombstone for those ids (left on the server or on another
// device by an earlier restore that omitted them) was enough. Completion
// events were not tombstoned, so the heatmap kept its squares while the
// chores and categories vanished.

function installGlobals(): void {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  } as Storage
  ;(globalThis as { window?: unknown }).window = globalThis
  if (!('dispatchEvent' in globalThis)) {
    ;(globalThis as Record<string, unknown>).dispatchEvent = () => true
  }
}
installGlobals()

const CAT = 'a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1'
const CHORE = 'b2b2b2b2-b2b2-b2b2-b2b2-b2b2b2b2b2b2'
const EVENT = 'c3c3c3c3-c3c3-c3c3-c3c3-c3c3c3c3c3c3'
const OTHER_CHORE = 'd4d4d4d4-d4d4-d4d4-d4d4-d4d4d4d4d4d4'
const OLD = '2026-01-01T00:00:00.000Z'
// When an earlier restore on the other device omitted these rows: recent, so
// the 90-day tombstone pruning in mergePayloads keeps it.
const TOMBSTONED_AT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

const backup: SyncPayload = {
  categories: [{ id: CAT, name: 'Home', sortOrder: 0, icon: 'Home', parentId: null, assignedUserSyncIds: [], updatedAt: OLD }],
  chores: [{
    id: CHORE, name: 'Mop kitchen', categorySyncId: CAT, sortOrder: 0, targetCadenceDays: 14,
    notifyWhenOverdue: false, autoScheduleToDayglance: false, preferredScheduleBehavior: null,
    seasonalStart: null, seasonalEnd: null, details: null, icon: 'Home', assignedUserSyncIds: [], createdAt: OLD, updatedAt: OLD,
  }],
  completionEvents: [{ id: EVENT, choreSyncId: CHORE, completedAt: OLD, note: null, source: 'manual', completedByUserSyncId: null }],
  users: [],
  settings: { multiUserEnabled: false },
  tombstones: {},
}

// What the server (or the other device) still holds: the same ids, deleted.
const staleRemote: SyncPayload = {
  categories: [], chores: [], completionEvents: [], users: [],
  settings: { multiUserEnabled: false },
  tombstones: { [CAT]: TOMBSTONED_AT, [CHORE]: TOMBSTONED_AT, [EVENT]: TOMBSTONED_AT },
}

async function sync(remote: SyncPayload): Promise<SyncPayload> {
  const { data } = mergePayloads(await buildPayload(), remote)
  await applyPayload(data, { allowEmpty: true })
  return data as SyncPayload
}

beforeAll(async () => { await db.open() })
beforeEach(async () => {
  await Promise.all([db.categories.clear(), db.chores.clear(), db.completionEvents.clear(), db.tombstones.clear(), db.users.clear()])
})

describe('#337 — a restore survives older tombstones for the same ids', () => {
  it('keeps the restored categories, chores and history through the next sync', async () => {
    await restoreFromBackup(backup)
    const merged = await sync(staleRemote)

    expect((await db.categories.toArray()).map(c => c.sync_id)).toEqual([CAT])
    expect((await db.chores.toArray()).map(c => c.sync_id)).toEqual([CHORE])
    expect((await db.completionEvents.toArray()).map(e => e.sync_id)).toEqual([EVENT])
    // And what goes back up carries them, so the other device gets them too.
    expect(merged.chores.map(c => c.id)).toEqual([CHORE])
    expect(merged.completionEvents.map(e => e.id)).toEqual([EVENT])
  })

  it('the other device, holding the old tombstones, receives the restored rows', async () => {
    // This device deleted the rows earlier and still has the tombstones.
    await db.tombstones.bulkPut(Object.entries(staleRemote.tombstones!).map(([id, deleted_at]) => ({ id, deleted_at })))
    // The server now has the restored copy, stamped after the deletion.
    const restoredAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const server: SyncPayload = {
      ...backup,
      categories: backup.categories.map(c => ({ ...c, updatedAt: restoredAt })),
      chores: backup.chores.map(c => ({ ...c, updatedAt: restoredAt })),
      completionEvents: backup.completionEvents.map(e => ({ ...e, updatedAt: restoredAt })),
      tombstones: staleRemote.tombstones,
    }
    await sync(server)

    expect(await db.chores.count()).toBe(1)
    expect(await db.completionEvents.count()).toBe(1)
  })

  it('still deletes a row whose tombstone is newer than it', async () => {
    await restoreFromBackup(backup)
    const later = new Date(Date.now() + 60_000).toISOString()
    await sync({ ...staleRemote, tombstones: { [CHORE]: later } })

    expect(await db.chores.count()).toBe(0)
    expect(await db.categories.count()).toBe(1)
  })

  it('still deletes rows the payload omits when their tombstone is newer', async () => {
    await restoreFromBackup({
      ...backup,
      chores: [...backup.chores, { ...backup.chores[0], id: OTHER_CHORE, name: 'Vacuum' }],
    })
    const later = new Date(Date.now() + 60_000).toISOString()
    await applyPayload({ ...staleRemote, tombstones: { [OTHER_CHORE]: later } }, { allowEmpty: true })

    expect((await db.chores.toArray()).map(c => c.sync_id)).toEqual([CHORE])
  })
})
