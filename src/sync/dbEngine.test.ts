import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { db } from '@/db/client'
import {
  getLocalEntity,
  isInsertOnly,
  getEntityLastModified,
  applyRemoteEntity,
  markAllLocalEntitiesDirty,
  createDbEngine,
} from './dbEngine'
import { getDeferredChores } from './deferredChores'
import { setVaultConfig } from './vaultConfig'
import type { DbSyncEngine } from '@glance-apps/sync'
import type { Category, Chore, CompletionEvent, User } from '@/types'
import type { SyncCategory, SyncChore } from './types'

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
  it('marks every local entity across all four tables dirty', async () => {
    const marked: string[] = []
    const fakeEngine = { markDirty: (id: string) => { marked.push(id) } } as unknown as DbSyncEngine
    await markAllLocalEntitiesDirty(fakeEngine)
    // The records seeded in beforeAll, one per table.
    expect(marked).toContain(USER_ID)
    expect(marked).toContain(CAT_ID)
    expect(marked).toContain(CHORE_ID)
    expect(marked).toContain(EVENT_ID)
    // Seed categories/chores populated on first open are included too.
    expect(marked.length).toBeGreaterThan(4)
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
    icon: 'Droplet', assignedUserSyncIds: [],
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

describe('createDbEngine stale pull-cursor recovery (≤1.3.x upgrade)', () => {
  const HWM_KEY = 'lastglance-db-sync-hwm'
  const RECOVERY_FLAG = 'lastglance-db-sync-hwm-recovery-v140'

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

  it('resets a poisoned pull cursor to 0 exactly once, then leaves it alone', () => {
    // Simulate a device whose KEY_HWM was advanced past unread peer rows by the
    // 1.3.x push-advances-pull bug.
    localStorage.setItem(HWM_KEY, '42')
    localStorage.removeItem(RECOVERY_FLAG)

    const engine = createDbEngine()
    expect(engine).not.toBeNull()
    // The cursor is rewound so the next pull re-lists the full history.
    expect(engine!.getHighWaterMark()).toBe(0)
    expect(localStorage.getItem(RECOVERY_FLAG)).not.toBeNull()

    // Idempotent: a later cursor advance must NOT be rewound again.
    engine!.setHighWaterMark(99)
    const engine2 = createDbEngine()
    expect(engine2!.getHighWaterMark()).toBe(99)
  })
})
