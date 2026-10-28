import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db, isPristineSeed, SEED_TIMESTAMP, SEED_CAT_SYNC_IDS, SEED_CHORE_SYNC_IDS } from '@/db/client'
import {
  getLocalEntity,
  isInsertOnly,
  getEntityLastModified,
  applyRemoteEntity,
  markAllLocalEntitiesDirty,
  createDbEngine,
  resolveCategoryParents,
} from './dbEngine'
import { getDeferredChores } from './deferredChores'
import { getDeferredCompletions } from './deferredCompletions'
import { setVaultConfig } from './vaultConfig'
import type { DbSyncEngine } from '@glance-apps/sync'
import type { Category, Chore, CompletionEvent, User } from '@/types'
import type { SyncCategory, SyncChore, SyncCompletionEvent } from './types'

// Minimal in-memory localStorage for the node test environment (the deferred
// chore buffer persists there).
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

// Stable ids for the records we seed and look up.
const USER_ID = '11111111-1111-1111-1111-111111111111'
const CAT_ID = '22222222-2222-2222-2222-222222222222'
const CHORE_ID = '33333333-3333-3333-3333-333333333333'
const EVENT_ID = '44444444-4444-4444-4444-444444444444'

let choreSyncIdForEvent = ''

beforeAll(async () => {
  const userKey = await db.users.add({
    name: 'Alice', sync_id: USER_ID, updated_at: '2026-01-01T00:00:00.000Z',
  } as unknown as User)
  expect(userKey).toBeTypeOf('number')

  const catKey = await db.categories.add({
    name: 'Garage', sort_order: 99, icon: 'Car', sync_id: CAT_ID,
    parent_sync_id: null, assigned_user_sync_ids: [], updated_at: '2026-02-02T00:00:00.000Z',
  } as unknown as Category)

  const choreKey = await db.chores.add({
    name: 'Sweep', category_id: catKey as number, category_sync_id: CAT_ID,
    sort_order: 0, target_cadence_days: 7, notify_when_overdue: false,
    auto_schedule_to_dayglance: false, preferred_schedule_behavior: null,
    seasonal_start: null, seasonal_end: null, icon: 'Broom', assigned_user_sync_ids: [],
    created_at: '2026-03-03T00:00:00.000Z', updated_at: '2026-03-04T00:00:00.000Z',
    sync_id: CHORE_ID,
  } as unknown as Chore)
  const chore = await db.chores.get(choreKey as number)
  choreSyncIdForEvent = chore!.sync_id

  await db.completionEvents.add({
    chore_id: choreKey as number, completed_at: '2026-04-04T00:00:00.000Z',
    note: 'done', source: 'manual', completed_by_user_sync_id: null, sync_id: EVENT_ID,
  } as unknown as CompletionEvent)
})

describe('getLocalEntity', () => {
  it('looks up a user by sync_id', async () => {
    const e = await getLocalEntity(USER_ID) as Record<string, unknown>
    expect(e).not.toBeNull()
    expect(e.id).toBe(USER_ID)
    expect(e.name).toBe('Alice')
    expect(e.updatedAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('looks up a category by sync_id', async () => {
    const e = await getLocalEntity(CAT_ID) as Record<string, unknown>
    expect(e.id).toBe(CAT_ID)
    expect(e.name).toBe('Garage')
    expect(e.sortOrder).toBe(99)
    expect(e.parentId).toBeNull()
  })

  it('looks up a chore by sync_id', async () => {
    const e = await getLocalEntity(CHORE_ID) as Record<string, unknown>
    expect(e.id).toBe(CHORE_ID)
    expect(e.name).toBe('Sweep')
    expect(e.categorySyncId).toBe(CAT_ID)
    expect(e.createdAt).toBe('2026-03-03T00:00:00.000Z')
  })

  it('looks up a completion event and resolves its choreSyncId', async () => {
    const e = await getLocalEntity(EVENT_ID) as Record<string, unknown>
    expect(e.id).toBe(EVENT_ID)
    expect(e.choreSyncId).toBe(choreSyncIdForEvent)
    expect(e.completedAt).toBe('2026-04-04T00:00:00.000Z')
  })

  it('returns null for an unknown sync_id', async () => {
    expect(await getLocalEntity('99999999-9999-9999-9999-999999999999')).toBeNull()
  })
})

describe('isInsertOnly', () => {
  it('is true only for completion events', () => {
    const evt = { id: EVENT_ID, choreSyncId: CHORE_ID, completedAt: '2026-04-04T00:00:00.000Z', note: null, source: 'manual', completedByUserSyncId: null }
    const cat = { id: CAT_ID, name: 'Garage', sortOrder: 1, icon: undefined, parentId: null, assignedUserSyncIds: [], updatedAt: '2026-02-02T00:00:00.000Z' }
    const chore = { id: CHORE_ID, name: 'Sweep', categorySyncId: CAT_ID, sortOrder: 0, updatedAt: '2026-03-04T00:00:00.000Z', createdAt: '2026-03-03T00:00:00.000Z' }
    const user = { id: USER_ID, name: 'Alice', updatedAt: '2026-01-01T00:00:00.000Z' }

    expect(isInsertOnly(evt)).toBe(true)
    expect(isInsertOnly(cat)).toBe(false)
    expect(isInsertOnly(chore)).toBe(false)
    expect(isInsertOnly(user)).toBe(false)
  })
})

describe('getEntityLastModified', () => {
  it('returns completedAt for completion events', () => {
    const evt = { id: EVENT_ID, choreSyncId: CHORE_ID, completedAt: '2026-04-04T00:00:00.000Z', note: null, source: 'manual', completedByUserSyncId: null }
    expect(getEntityLastModified(evt)).toBe('2026-04-04T00:00:00.000Z')
  })

  it('returns updatedAt for categories, chores, and users', () => {
    const cat = { id: CAT_ID, name: 'Garage', sortOrder: 1, parentId: null, assignedUserSyncIds: [], updatedAt: '2026-02-02T00:00:00.000Z' }
    const chore = { id: CHORE_ID, name: 'Sweep', categorySyncId: CAT_ID, sortOrder: 0, updatedAt: '2026-03-04T00:00:00.000Z', createdAt: '2026-03-03T00:00:00.000Z' }
    const user = { id: USER_ID, name: 'Alice', updatedAt: '2026-01-01T00:00:00.000Z' }
    expect(getEntityLastModified(cat)).toBe('2026-02-02T00:00:00.000Z')
    expect(getEntityLastModified(chore)).toBe('2026-03-04T00:00:00.000Z')
    expect(getEntityLastModified(user)).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('markAllLocalEntitiesDirty', () => {
  it('marks user-owned entities across all four tables dirty', async () => {
    const marked: string[] = []
    const fakeEngine = { markDirty: (id: string) => { marked.push(id) } } as unknown as DbSyncEngine
    await markAllLocalEntitiesDirty(fakeEngine)
    // The records seeded in beforeAll, one per table.
    expect(marked).toContain(USER_ID)
    expect(marked).toContain(CAT_ID)
    expect(marked).toContain(CHORE_ID)
    expect(marked).toContain(EVENT_ID)
  })

  it('excludes pristine sample data so a fresh device cannot clobber another device edits', async () => {
    const marked: string[] = []
    const fakeEngine = { markDirty: (id: string) => { marked.push(id) } } as unknown as DbSyncEngine
    await markAllLocalEntitiesDirty(fakeEngine)
    // Seed categories/chores populated on first open still carry SEED_TIMESTAMP,
    // so none of their fixed sync_ids should be in the snapshot.
    for (const id of [...SEED_CAT_SYNC_IDS, ...SEED_CHORE_SYNC_IDS]) {
      expect(marked).not.toContain(id)
    }
  })

  it('includes a seed row once it has been edited (updated_at bumped off SEED_TIMESTAMP)', async () => {
    const editedSeedId = SEED_CHORE_SYNC_IDS[0]
    const row = await db.chores.where('sync_id').equals(editedSeedId).first()
    expect(row).toBeDefined()
    await db.chores.update(row!.id!, { updated_at: '2026-06-06T00:00:00.000Z' })
    try {
      const marked: string[] = []
      const fakeEngine = { markDirty: (id: string) => { marked.push(id) } } as unknown as DbSyncEngine
      await markAllLocalEntitiesDirty(fakeEngine)
      expect(marked).toContain(editedSeedId)
    } finally {
      // Restore so later tests see pristine seed again.
      await db.chores.update(row!.id!, { updated_at: SEED_TIMESTAMP })
    }
  })
})

describe('isPristineSeed', () => {
  it('is true for an untouched seed row', () => {
    expect(isPristineSeed({ sync_id: SEED_CHORE_SYNC_IDS[0], updated_at: SEED_TIMESTAMP })).toBe(true)
  })

  it('is false for a seed row whose updated_at has been bumped by an edit', () => {
    expect(isPristineSeed({ sync_id: SEED_CHORE_SYNC_IDS[0], updated_at: '2026-06-06T00:00:00.000Z' })).toBe(false)
  })

  it('is false for a non-seed row even at the seed timestamp', () => {
    expect(isPristineSeed({ sync_id: CHORE_ID, updated_at: SEED_TIMESTAMP })).toBe(false)
  })
})

describe('applyRemoteEntity out-of-order chore and category', () => {
  // A custom category that does not exist locally yet, and a chore under it.
  const DCAT_ID = '55555555-5555-5555-5555-555555555555'
  const DCHORE_ID = '66666666-6666-6666-6666-666666666666'

  const remoteCategory: SyncCategory = {
    id: DCAT_ID, name: 'Workshop', sortOrder: 5, icon: 'Wrench',
    parentId: null, assignedUserSyncIds: [], updatedAt: '2026-05-01T00:00:00.000Z',
  }
  const remoteChore: SyncChore = {
    id: DCHORE_ID, name: 'Oil the bench', categorySyncId: DCAT_ID, sortOrder: 0,
    targetCadenceDays: 30, notifyWhenOverdue: false, autoScheduleToDayglance: false,
    preferredScheduleBehavior: null, seasonalStart: null, seasonalEnd: null,
    details: null, icon: 'Droplet', assignedUserSyncIds: [],
    createdAt: '2026-05-02T00:00:00.000Z', updatedAt: '2026-05-02T00:00:00.000Z',
  }

  it('parks a chore whose category has not arrived, then applies it once the category lands', async () => {
    // Chore arrives first: its category is not present, so it must be parked.
    await applyRemoteEntity(DCHORE_ID, remoteChore)
    expect(await db.chores.where('sync_id').equals(DCHORE_ID).first()).toBeUndefined()
    expect(getDeferredChores().map(c => c.id)).toContain(DCHORE_ID)

    // Category arrives next: draining must apply the parked chore and clear it.
    await applyRemoteEntity(DCAT_ID, remoteCategory)
    const landed = await db.chores.where('sync_id').equals(DCHORE_ID).first()
    expect(landed).toBeTruthy()
    const cat = await db.categories.where('sync_id').equals(DCAT_ID).first()
    expect(landed!.category_id).toBe(cat!.id)
    expect(getDeferredChores().map(c => c.id)).not.toContain(DCHORE_ID)
  })
})

describe('chore details across the sync boundary (#271)', () => {
  const FCAT_ID = 'f1f1f1f1-f1f1-f1f1-f1f1-f1f1f1f1f1f1'
  const FCHORE_ID = 'f2f2f2f2-f2f2-f2f2-f2f2-f2f2f2f2f2f2'
  const DETAILS = 'Tomato feed (fruit, veg)\nAll-purpose (flowers & pots)'

  const remoteCategory: SyncCategory = {
    id: FCAT_ID, name: 'Garden', sortOrder: 8, icon: 'Leaf',
    parentId: null, assignedUserSyncIds: [], updatedAt: '2026-07-01T00:00:00.000Z',
  }
  const remoteChore: SyncChore = {
    id: FCHORE_ID, name: 'Garden feeding', categorySyncId: FCAT_ID, sortOrder: 0,
    targetCadenceDays: 14, notifyWhenOverdue: false, autoScheduleToDayglance: false,
    preferredScheduleBehavior: null, seasonalStart: null, seasonalEnd: null,
    details: DETAILS, icon: 'Leaf', assignedUserSyncIds: [],
    createdAt: '2026-07-02T00:00:00.000Z', updatedAt: '2026-07-02T00:00:00.000Z',
  }

  it('reads a pre-#271 local row as details: null rather than undefined', async () => {
    // The chore seeded in beforeAll was written without the field, exactly like a
    // row that predates the migration.
    const e = await getLocalEntity(CHORE_ID) as Record<string, unknown>
    expect(e.details).toBeNull()
  })

  it('applies details on insert and on a later update, and clears them when the remote drops them', async () => {
    await applyRemoteEntity(FCAT_ID, remoteCategory)
    await applyRemoteEntity(FCHORE_ID, remoteChore)
    expect((await db.chores.where('sync_id').equals(FCHORE_ID).first())!.details).toBe(DETAILS)

    // Round-trips back out in the payload shape.
    const out = await getLocalEntity(FCHORE_ID) as Record<string, unknown>
    expect(out.details).toBe(DETAILS)

    // An edit that empties the field propagates as null, not as a stale value.
    await applyRemoteEntity(FCHORE_ID, {
      ...remoteChore, details: null, updatedAt: '2026-07-03T00:00:00.000Z',
    })
    expect((await db.chores.where('sync_id').equals(FCHORE_ID).first())!.details).toBeNull()
  })

  it('stores null when an older client sends a chore with no details key at all', async () => {
    const legacy = { ...remoteChore, updatedAt: '2026-07-04T00:00:00.000Z' } as Partial<SyncChore>
    delete legacy.details
    await applyRemoteEntity(FCHORE_ID, legacy as SyncChore)
    expect((await db.chores.where('sync_id').equals(FCHORE_ID).first())!.details).toBeNull()
  })
})

describe('chore pinned flag across the sync boundary', () => {
  const PCAT_ID = 'f3f3f3f3-f3f3-f3f3-f3f3-f3f3f3f3f3f3'
  const PCHORE_ID = 'f4f4f4f4-f4f4-f4f4-f4f4-f4f4f4f4f4f4'

  const remoteCategory: SyncCategory = {
    id: PCAT_ID, name: 'Kitchen', sortOrder: 9, icon: 'Utensils',
    parentId: null, assignedUserSyncIds: [], updatedAt: '2026-10-01T00:00:00.000Z',
  }
  const remoteChore: SyncChore = {
    id: PCHORE_ID, name: 'Descale kettle', categorySyncId: PCAT_ID, sortOrder: 0,
    targetCadenceDays: 30, notifyWhenOverdue: false, autoScheduleToDayglance: false,
    preferredScheduleBehavior: null, seasonalStart: null, seasonalEnd: null,
    details: null, pinned: true, icon: 'Coffee', assignedUserSyncIds: [],
    createdAt: '2026-10-02T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
  }
  const localPinned = async () => (await db.chores.where('sync_id').equals(PCHORE_ID).first())!.pinned

  it('reads a local row written before the field as pinned: false', async () => {
    const e = await getLocalEntity(CHORE_ID) as Record<string, unknown>
    expect(e.pinned).toBe(false)
  })

  it('applies pinned on insert, round-trips it, and unpins on a later update', async () => {
    await applyRemoteEntity(PCAT_ID, remoteCategory)
    await applyRemoteEntity(PCHORE_ID, remoteChore)
    expect(await localPinned()).toBe(true)
    expect((await getLocalEntity(PCHORE_ID) as Record<string, unknown>).pinned).toBe(true)

    await applyRemoteEntity(PCHORE_ID, { ...remoteChore, pinned: false, updatedAt: '2026-10-03T00:00:00.000Z' })
    expect(await localPinned()).toBe(false)
  })

  it('keeps the local pin when an older client sends the chore without the key', async () => {
    await applyRemoteEntity(PCHORE_ID, { ...remoteChore, pinned: true, updatedAt: '2026-10-04T00:00:00.000Z' })
    const legacy = { ...remoteChore, name: 'Descale the kettle', updatedAt: '2026-10-05T00:00:00.000Z' } as Partial<SyncChore>
    delete legacy.pinned
    await applyRemoteEntity(PCHORE_ID, legacy as SyncChore)
    const row = (await db.chores.where('sync_id').equals(PCHORE_ID).first())!
    expect(row.name).toBe('Descale the kettle')
    expect(row.pinned).toBe(true)
  })
})

describe('pins dropped by a build that predates pinning', () => {
  // The reported case: device A pins a chore; device B, still on a build
  // without the field, pulls the chore and stores its other fields and its
  // updatedAt but not the pin. After B upgrades, its copy ties the vault's on
  // updatedAt, and the engine keeps local on a tie (remote must be strictly
  // newer). The engine compares ts(getEntityLastModified(...)), new Date(v)
  // .getTime(), so these assert on exactly that.
  const LCAT_ID = 'f5f5f5f5-f5f5-f5f5-f5f5-f5f5f5f5f5f5'
  const LCHORE_ID = 'f6f6f6f6-f6f6-f6f6-f6f6-f6f6f6f6f6f6'
  const AT = '2026-10-27T23:10:00.000Z'
  const ts = (v: string | number | undefined) => new Date(v as string).getTime()

  const vaultChore: SyncChore = {
    id: LCHORE_ID, name: 'Algae discs', categorySyncId: LCAT_ID, sortOrder: 0,
    targetCadenceDays: 7, notifyWhenOverdue: false, autoScheduleToDayglance: false,
    preferredScheduleBehavior: null, seasonalStart: null, seasonalEnd: null,
    details: null, pinned: true, icon: 'Fish', assignedUserSyncIds: [],
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: AT,
  }

  it('lets the pinned vault copy win the tie against a copy that lost the pin', async () => {
    await applyRemoteEntity(LCAT_ID, {
      id: LCAT_ID, name: 'Fish Tanks', sortOrder: 10, icon: 'Fish',
      parentId: null, assignedUserSyncIds: [], updatedAt: AT,
    } as SyncCategory)
    await applyRemoteEntity(LCHORE_ID, vaultChore)
    // What the old build left behind: same updatedAt, no pin (the v15
    // migration then fills false).
    const row = (await db.chores.where('sync_id').equals(LCHORE_ID).first())!
    await db.chores.update(row.id, { pinned: false })

    const local = await getLocalEntity(LCHORE_ID)
    expect(ts(getEntityLastModified(vaultChore))).toBeGreaterThan(ts(getEntityLastModified(local)))

    // Which the engine then applies, restoring the pin.
    await applyRemoteEntity(LCHORE_ID, vaultChore)
    expect((await db.chores.where('sync_id').equals(LCHORE_ID).first())!.pinned).toBe(true)
  })

  it('still lets a real unpin, which stamps a new updatedAt, beat an older pinned copy', async () => {
    const unpinned = { ...vaultChore, pinned: false, updatedAt: '2026-10-27T23:10:05.000Z' }
    expect(ts(getEntityLastModified(unpinned))).toBeGreaterThan(ts(getEntityLastModified(vaultChore)))
  })

  it('leaves unpinned chores and other entities on plain updatedAt', () => {
    expect(getEntityLastModified({ ...vaultChore, pinned: false })).toBe(AT)
    expect(getEntityLastModified({ id: LCAT_ID, name: 'x', sortOrder: 0, parentId: null, updatedAt: AT })).toBe(AT)
  })
})

describe('applyRemoteEntity completion before its chore', () => {
  // Regression guard for "received some completions, not all": a completion whose
  // chore is not present yet (the chore was edited after the completion, so its
  // row carries a higher seq and arrives later, or the chore is itself parked
  // awaiting its category) must be parked and applied once the chore lands — never
  // dropped, because an insert-only completion is never re-listed.
  const ECAT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  const ECHORE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  const EEVENT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

  const remoteCategory: SyncCategory = {
    id: ECAT_ID, name: 'Yard', sortOrder: 7, icon: 'Tree',
    parentId: null, assignedUserSyncIds: [], updatedAt: '2026-06-10T00:00:00.000Z',
  }
  const remoteChore: SyncChore = {
    id: ECHORE_ID, name: 'Mow', categorySyncId: ECAT_ID, sortOrder: 0,
    targetCadenceDays: 14, notifyWhenOverdue: false, autoScheduleToDayglance: false,
    preferredScheduleBehavior: null, seasonalStart: null, seasonalEnd: null,
    details: null, icon: 'Scissors', assignedUserSyncIds: [],
    createdAt: '2026-06-11T00:00:00.000Z', updatedAt: '2026-06-12T00:00:00.000Z',
  }
  const remoteEvent: SyncCompletionEvent = {
    id: EEVENT_ID, choreSyncId: ECHORE_ID, completedAt: '2026-06-11T09:00:00.000Z',
    note: null, source: 'manual', completedByUserSyncId: null,
  }

  it('parks a completion whose chore is absent, then applies it once the chore lands', async () => {
    // Completion arrives first: chore not present, so it must be parked, not dropped.
    await applyRemoteEntity(EEVENT_ID, remoteEvent)
    expect(await db.completionEvents.where('sync_id').equals(EEVENT_ID).first()).toBeUndefined()
    expect(getDeferredCompletions().map(e => e.id)).toContain(EEVENT_ID)

    // Chore is still parked too (its category has not arrived): completion stays parked.
    await applyRemoteEntity(ECHORE_ID, remoteChore)
    expect(await db.completionEvents.where('sync_id').equals(EEVENT_ID).first()).toBeUndefined()
    expect(getDeferredCompletions().map(e => e.id)).toContain(EEVENT_ID)

    // Category lands: chore drains, and draining the chore drains the completion.
    await applyRemoteEntity(ECAT_ID, remoteCategory)
    const landedChore = await db.chores.where('sync_id').equals(ECHORE_ID).first()
    expect(landedChore).toBeTruthy()
    const landedEvent = await db.completionEvents.where('sync_id').equals(EEVENT_ID).first()
    expect(landedEvent).toBeTruthy()
    expect(landedEvent!.chore_id).toBe(landedChore!.id)
    expect(getDeferredCompletions().map(e => e.id)).not.toContain(EEVENT_ID)
  })
})

describe('applyRemoteEntity subcategory before its parent', () => {
  // Regression guard for the "all subcategories show as parent categories" bug:
  // the vault applies categories one row at a time in seq order, which is NOT
  // guaranteed parents-first. A subcategory whose parent has not arrived yet must
  // still end up linked once the parent lands, because the UI groups strictly by
  // parent_category_id — an unresolved (null/undefined) FK renders as a ROOT.
  const PARENT_ID = '77777777-7777-7777-7777-777777777777'
  const CHILD_A_ID = '88888888-8888-8888-8888-888888888888'
  const CHILD_B_ID = '99999999-9999-9999-9999-999999999999'

  const parent: SyncCategory = {
    id: PARENT_ID, name: 'Home', sortOrder: 1, icon: 'House',
    parentId: null, assignedUserSyncIds: [], updatedAt: '2026-06-01T00:00:00.000Z',
  }
  const childA: SyncCategory = {
    id: CHILD_A_ID, name: 'Kitchen', sortOrder: 2, icon: 'Fork',
    parentId: PARENT_ID, assignedUserSyncIds: [], updatedAt: '2026-06-02T00:00:00.000Z',
  }
  const childB: SyncCategory = {
    id: CHILD_B_ID, name: 'Bathroom', sortOrder: 3, icon: 'Bath',
    parentId: PARENT_ID, assignedUserSyncIds: [], updatedAt: '2026-06-03T00:00:00.000Z',
  }

  it('back-fills parent_category_id for children that arrive before their parent', async () => {
    // Both children arrive first: parent is absent, so the local FK is unset and
    // they would (wrongly) render as roots.
    await applyRemoteEntity(CHILD_A_ID, childA)
    await applyRemoteEntity(CHILD_B_ID, childB)
    const beforeA = await db.categories.where('sync_id').equals(CHILD_A_ID).first()
    const beforeB = await db.categories.where('sync_id').equals(CHILD_B_ID).first()
    expect(beforeA!.parent_sync_id).toBe(PARENT_ID)
    expect(beforeA!.parent_category_id).toBeUndefined()
    expect(beforeB!.parent_category_id).toBeUndefined()

    // Parent lands: both waiting children must now be linked to it.
    await applyRemoteEntity(PARENT_ID, parent)
    const parentRow = await db.categories.where('sync_id').equals(PARENT_ID).first()
    const afterA = await db.categories.where('sync_id').equals(CHILD_A_ID).first()
    const afterB = await db.categories.where('sync_id').equals(CHILD_B_ID).first()
    expect(afterA!.parent_category_id).toBe(parentRow!.id)
    expect(afterB!.parent_category_id).toBe(parentRow!.id)
    // The parent itself stays a root.
    expect(parentRow!.parent_category_id).toBeUndefined()
  })
})

describe('resolveCategoryParents repairs already-flat categories', () => {
  // A device that received its categories flat under an earlier build has them
  // stored with parent_sync_id set but parent_category_id missing. A re-pull will
  // NOT fix them (last-writer-wins skips already-present rows with unchanged
  // updatedAt), so the standalone repair must relink them directly from local data.
  const RPARENT_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
  const RCHILD_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'

  it('links a flat subcategory to a parent that is already present locally', async () => {
    const parentKey = await db.categories.add({
      name: 'Vehicles', sort_order: 1, icon: 'Car', sync_id: RPARENT_ID,
      parent_sync_id: null, assigned_user_sync_ids: [], updated_at: '2026-06-15T00:00:00.000Z',
    } as unknown as Category)
    // Child stored flat: parent_sync_id is correct, but parent_category_id is unset.
    await db.categories.add({
      name: 'Motorcycle', sort_order: 2, icon: 'Bike', sync_id: RCHILD_ID,
      parent_sync_id: RPARENT_ID, assigned_user_sync_ids: [], updated_at: '2026-06-16T00:00:00.000Z',
    } as unknown as Category)

    const before = await db.categories.where('sync_id').equals(RCHILD_ID).first()
    expect(before!.parent_category_id).toBeUndefined()

    const changed = await resolveCategoryParents()
    expect(changed).toBeGreaterThanOrEqual(1)

    const after = await db.categories.where('sync_id').equals(RCHILD_ID).first()
    expect(after!.parent_category_id).toBe(parentKey as number)

    // Idempotent: a second pass changes nothing for this pair.
    const stillLinked = await db.categories.where('sync_id').equals(RCHILD_ID).first()
    expect(stillLinked!.parent_category_id).toBe(parentKey as number)
  })
})

describe('createDbEngine stale pull-cursor recovery', () => {
  const HWM_KEY = 'lastglance-db-sync-hwm'
  const RECOVERY_FLAG = 'lastglance-db-sync-hwm-recovery-gen'
  const CURRENT_GEN = 3

  beforeAll(() => {
    setVaultConfig({
      enabled: true,
      vaultUrl: 'https://vault.example.test',
      vaultToken: 'test-token',
      accountId: 'acct-test',
    })
  })

  afterAll(() => {
    setVaultConfig(null)
    localStorage.removeItem(HWM_KEY)
    localStorage.removeItem(RECOVERY_FLAG)
  })

  it('rewinds the pull cursor to 0 once per generation, then leaves it alone', () => {
    // A device that has never run recovery (no flag).
    localStorage.setItem(HWM_KEY, '42')
    localStorage.removeItem(RECOVERY_FLAG)

    const engine = createDbEngine()
    expect(engine).not.toBeNull()
    // Cursor rewound so the next pull re-lists the full history.
    expect(engine!.getHighWaterMark()).toBe(0)
    expect(localStorage.getItem(RECOVERY_FLAG)).toBe(String(CURRENT_GEN))

    // Idempotent within a generation: a later cursor advance is NOT rewound.
    engine!.setHighWaterMark(99)
    const engine2 = createDbEngine()
    expect(engine2!.getHighWaterMark()).toBe(99)
  })

  it('re-runs when the device is behind the current generation', () => {
    // A device that already ran an earlier generation's recovery (gen 2, the
    // one before the pinned-chore re-pull).
    localStorage.setItem(HWM_KEY, '77')
    localStorage.setItem(RECOVERY_FLAG, '2')

    const engine = createDbEngine()
    expect(engine!.getHighWaterMark()).toBe(0)
    expect(localStorage.getItem(RECOVERY_FLAG)).toBe(String(CURRENT_GEN))
  })
})

describe('first-sync snapshot seeding gate', () => {
  // Regression guard for the SSE self-nudge loop: the old gate re-ran the
  // full-snapshot marking on EVERY cycle while getHighWaterMark() === 0, so
  // with the pull failing (or backed off) while pushes succeeded, each cycle
  // re-pushed the whole dataset — and under SSE each push's own nudge
  // triggered the next cycle. The gate is now a one-shot persisted flag: mark
  // once, latch, and let the engine's persisted dirty set own delivery.
  //
  // The cycles below fail fast inside the engine (no passphrase in session →
  // ensureRootKey throws PASSPHRASE_REQUIRED before any network) — deliberate:
  // seeding runs before the engine cycle, and a failing cycle is exactly the
  // state the old gate looped in.
  const HWM_KEY = 'lastglance-db-sync-hwm'
  const RECOVERY_FLAG = 'lastglance-db-sync-hwm-recovery-gen'
  const SEEDED_FLAG = 'lastglance-db-sync-snapshot-seeded'
  const DIRTY_KEY = 'lastglance-db-sync-dirty'

  beforeAll(() => {
    setVaultConfig({
      enabled: true,
      vaultUrl: 'http://127.0.0.1:9',
      vaultToken: 'test-token',
      accountId: 'acct-test',
    })
    // Keep the recovery path out of these tests' way.
    localStorage.setItem(RECOVERY_FLAG, '2')
  })

  afterAll(() => {
    setVaultConfig(null)
    for (const k of [HWM_KEY, RECOVERY_FLAG, SEEDED_FLAG, DIRTY_KEY]) localStorage.removeItem(k)
  })

  it('seeds once on a fresh device, then never re-marks (the loop regression)', async () => {
    localStorage.removeItem(HWM_KEY)
    localStorage.removeItem(SEEDED_FLAG)
    localStorage.removeItem(DIRTY_KEY)

    const engine = createDbEngine()!
    await engine.dbSyncCycle()

    // Marking completed and latched: the rows seeded in beforeAll are dirty.
    expect(localStorage.getItem(SEEDED_FLAG)).toBe('1')
    const dirty = engine.getDirtySet()
    expect(dirty).toContain(CAT_ID)
    expect(dirty).toContain(EVENT_ID)

    // The old gate's loop condition: HWM is STILL 0 (no pull succeeded), and
    // another cycle runs. It must NOT re-mark — that re-mark is what re-pushed
    // the full dataset every cycle.
    engine.clearDirty()
    expect(engine.getHighWaterMark()).toBe(0)
    await engine.dbSyncCycle()
    expect(engine.getDirtySet()).toEqual([])
  })

  it('migration shim: a pre-flag device whose first sync already completed latches without re-marking', async () => {
    // An upgrading device: no flag, but a pull cursor past 0 proves the first
    // sync happened under the old gate. It must not burst a redundant
    // full-snapshot push (and its fleet-wide nudges) on upgrade.
    localStorage.setItem(HWM_KEY, '42')
    localStorage.removeItem(SEEDED_FLAG)
    localStorage.removeItem(DIRTY_KEY)

    const engine = createDbEngine()!
    await engine.dbSyncCycle()

    expect(localStorage.getItem(SEEDED_FLAG)).toBe('1')
    expect(engine.getDirtySet()).toEqual([])
  })
})
