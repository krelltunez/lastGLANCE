import { db, SEED_CAT_SYNC_IDS, SEED_CHORE_SYNC_IDS } from './client'
import type { Category, Chore, ChoreWithLastCompletion, CompletionEvent, User } from '@/types'
import { markDirty, markDeleted } from '@/sync/dirtyTracker'
import { getMultiUserEnabled, setMultiUserEnabled } from '@/multiuser/settings'
import dayjs from 'dayjs'

// Tombstone helpers

async function writeTombstone(syncId: string): Promise<void> {
  await db.tombstones.put({ id: syncId, deleted_at: new Date().toISOString() })
}

// Categories

export async function getCategories(): Promise<Category[]> {
  return db.categories.orderBy('sort_order').toArray()
}

export async function createCategory(
  name: string,
  sort_order?: number,
  icon?: string,
  parent_category_id?: number,
  assigned_user_sync_ids: string[] = [],
): Promise<number> {
  const order = sort_order ?? (await db.categories.count())
  let parent_sync_id: string | null = null
  if (parent_category_id) {
    const parent = await db.categories.get(parent_category_id)
    parent_sync_id = parent?.sync_id ?? null
  }
  const sync_id = crypto.randomUUID()
  const id = await db.categories.add({
    name,
    sort_order: order,
    icon,
    parent_category_id,
    sync_id,
    parent_sync_id,
    assigned_user_sync_ids,
    updated_at: new Date().toISOString(),
  } as Category)
  markDirty(sync_id)
  return id
}

export async function updateCategory(id: number, fields: { name?: string; icon?: string; parent_category_id?: number | null; assigned_user_sync_ids?: string[] }): Promise<void> {
  const { parent_category_id, ...simpleFields } = fields
  const updated_at = new Date().toISOString()
  // sync_ids of any subcategories we relocate alongside this category (see below).
  const movedChildSyncIds: string[] = []

  await db.transaction('rw', db.categories, async () => {
    // Update simple fields (name, icon) with timestamp
    if (Object.keys(simpleFields).length > 0) {
      await db.categories.update(id, { ...simpleFields, updated_at })
    }
    if ('parent_category_id' in fields) {
      if (parent_category_id) {
        // Resolve parent sync_id
        const parent = await db.categories.get(parent_category_id)
        await db.categories.update(id, {
          parent_category_id,
          parent_sync_id: parent?.sync_id ?? null,
          updated_at,
        })
        // Nesting this category would push its own subcategories to a third level,
        // which the two-level renderer cannot draw — the classic "chores vanished
        // after re-parenting" data-loss report (#191). Instead of hiding them, lift
        // this category's direct subcategories up to the same destination parent so
        // they become siblings of it. Their chores are untouched (chores reference
        // their category, which simply moved up one level), and everything stays at
        // a drawable depth. The user can reorganise from there.
        const children = await db.categories.where('parent_category_id').equals(id).toArray()
        for (const child of children) {
          await db.categories.update(child.id!, {
            parent_category_id,
            parent_sync_id: parent?.sync_id ?? null,
            updated_at,
          })
          if (child.sync_id) movedChildSyncIds.push(child.sync_id)
        }
      } else {
        // Promote to root: delete the field entirely rather than setting null
        await db.categories.where('id').equals(id).modify((cat: Category) => {
          delete (cat as unknown as Record<string, unknown>).parent_category_id
          ;(cat as unknown as Record<string, unknown>).parent_sync_id = null
          ;(cat as unknown as Record<string, unknown>).updated_at = updated_at
        })
      }
    } else if (Object.keys(simpleFields).length === 0) {
      // Nothing to update but stamp the timestamp anyway
      await db.categories.update(id, { updated_at })
    }
  })

  const cat = await db.categories.get(id)
  markDirty(cat?.sync_id)
  for (const sid of movedChildSyncIds) markDirty(sid)
}

export async function getAllCompletionCounts(): Promise<Map<string, number>> {
  const all = await db.completionEvents.toArray()
  const counts = new Map<string, number>()
  for (const evt of all) {
    const d = dayjs(evt.completed_at).format('YYYY-MM-DD')
    counts.set(d, (counts.get(d) ?? 0) + 1)
  }
  return counts
}

export async function deleteCategory(id: number): Promise<void> {
  let deletedSyncIds: string[] = []
  await db.transaction('rw', db.categories, db.chores, db.completionEvents, db.tombstones, async () => {
    const subcats = await db.categories.where('parent_category_id').equals(id).toArray()
    const catIds = [id, ...subcats.map(c => c.id!)]

    // Collect all sync_ids for tombstoning
    const rootCat = await db.categories.get(id)
    const catSyncIds: string[] = []
    if (rootCat?.sync_id) catSyncIds.push(rootCat.sync_id)
    for (const sub of subcats) if (sub.sync_id) catSyncIds.push(sub.sync_id)

    const choreSyncIds: string[] = []
    const evtSyncIds: string[] = []

    for (const catId of catIds) {
      const chores = await db.chores.where('category_id').equals(catId).toArray()
      for (const chore of chores) if (chore.sync_id) choreSyncIds.push(chore.sync_id)
      const evts = await db.completionEvents.where('chore_id').anyOf(chores.map(c => c.id!)).toArray()
      for (const evt of evts) if (evt.sync_id) evtSyncIds.push(evt.sync_id)
      await db.completionEvents.where('chore_id').anyOf(chores.map(c => c.id!)).delete()
      await db.chores.where('category_id').equals(catId).delete()
    }
    await db.categories.where('id').anyOf(subcats.map(c => c.id!)).delete()
    await db.categories.delete(id)

    // Write tombstones
    const now = new Date().toISOString()
    const allSyncIds = [...catSyncIds, ...choreSyncIds, ...evtSyncIds]
    if (allSyncIds.length > 0) {
      await db.tombstones.bulkPut(allSyncIds.map(sid => ({ id: sid, deleted_at: now })))
    }
    deletedSyncIds = allSyncIds
  })
  for (const sid of deletedSyncIds) markDeleted(sid)
}

// Chores

export async function getChoresForCategory(categoryId: number): Promise<ChoreWithLastCompletion[]> {
  const chores = await db.chores.where('category_id').equals(categoryId).sortBy('sort_order')

  return Promise.all(
    chores.map(async chore => {
      const last = await db.completionEvents
        .where('chore_id')
        .equals(chore.id!)
        .toArray()
        .then(evts => evts.sort((a, b) => b.completed_at.localeCompare(a.completed_at))[0] ?? null)

      const elapsed_days = last
        ? dayjs().diff(dayjs(last.completed_at), 'minute') / (60 * 24)
        : null

      return {
        ...chore,
        last_completed_at: last?.completed_at ?? null,
        elapsed_days: elapsed_days !== null ? Math.round(elapsed_days * 10) / 10 : null,
      }
    })
  )
}

export async function createChore(
  data: Omit<Chore, 'id' | 'sort_order' | 'created_at' | 'updated_at' | 'sync_id' | 'category_sync_id'>
): Promise<number> {
  const now = dayjs().toISOString()
  const count = await db.chores.where('category_id').equals(data.category_id).count()
  const cat = await db.categories.get(data.category_id)
  const category_sync_id = cat?.sync_id ?? null
  const sync_id = crypto.randomUUID()
  const id = await db.chores.add({
    ...data,
    sort_order: count,
    created_at: now,
    updated_at: now,
    sync_id,
    category_sync_id,
  } as Chore)
  markDirty(sync_id)
  return id
}

export async function reorderChores(orderedIds: number[]): Promise<void> {
  await db.transaction('rw', db.chores, () =>
    Promise.all(orderedIds.map((id, idx) => db.chores.update(id, { sort_order: idx, updated_at: dayjs().toISOString() })))
  )
  const chores = await db.chores.bulkGet(orderedIds)
  for (const c of chores) markDirty(c?.sync_id)
}

export async function reorderCategories(orderedIds: number[]): Promise<void> {
  await db.transaction('rw', db.categories, () =>
    Promise.all(orderedIds.map((id, idx) => db.categories.update(id, { sort_order: idx, updated_at: dayjs().toISOString() })))
  )
  const categories = await db.categories.bulkGet(orderedIds)
  for (const c of categories) markDirty(c?.sync_id)
}

export async function updateChore(
  id: number,
  data: Partial<Omit<Chore, 'id' | 'created_at' | 'updated_at'>> & { icon?: string }
): Promise<void> {
  let extra: { category_sync_id?: string | null } = {}
  if (data.category_id != null) {
    const cat = await db.categories.get(data.category_id)
    extra = { category_sync_id: cat?.sync_id ?? null }
  }
  await db.chores.update(id, { ...data, ...extra, updated_at: dayjs().toISOString() })
  const chore = await db.chores.get(id)
  markDirty(chore?.sync_id)
}

export async function deleteChore(id: number): Promise<void> {
  let deletedSyncIds: string[] = []
  await db.transaction('rw', db.chores, db.completionEvents, db.tombstones, async () => {
    const chore = await db.chores.get(id)
    const evts = await db.completionEvents.where('chore_id').equals(id).toArray()
    const evtSyncIds = evts.map(e => e.sync_id).filter(Boolean)
    await db.completionEvents.where('chore_id').equals(id).delete()
    await db.chores.delete(id)

    // Write tombstones
    const now = new Date().toISOString()
    const syncIds = [
      ...(chore?.sync_id ? [chore.sync_id] : []),
      ...evtSyncIds,
    ]
    if (syncIds.length > 0) {
      await db.tombstones.bulkPut(syncIds.map(sid => ({ id: sid, deleted_at: now })))
    }
    deletedSyncIds = syncIds
  })
  for (const sid of deletedSyncIds) markDeleted(sid)
}

// Completion events

export async function logCompletion(
  choreId: number,
  opts: { note?: string; completedAt?: string; source?: 'manual' | 'dayglance'; completedByUserSyncId?: string | null; syncId?: string } = {}
): Promise<number> {
  const sync_id = opts.syncId ?? crypto.randomUUID()
  const id = await db.completionEvents.add({
    chore_id: choreId,
    completed_at: opts.completedAt ?? dayjs().toISOString(),
    note: opts.note ?? null,
    source: opts.source ?? 'manual',
    completed_by_user_sync_id: opts.completedByUserSyncId ?? null,
    sync_id,
  } as CompletionEvent)
  // Completion events are insert-only: mark dirty at creation time.
  markDirty(sync_id)
  return id
}

export async function getCompletionHistory(
  choreId: number,
  limit = 50
): Promise<CompletionEvent[]> {
  return db.completionEvents
    .where('chore_id')
    .equals(choreId)
    .toArray()
    .then(evts => evts.sort((a, b) => b.completed_at.localeCompare(a.completed_at)).slice(0, limit))
}

export async function updateCompletionNote(id: number, note: string | null): Promise<void> {
  await db.completionEvents.update(id, { note: note || null })
  const evt = await db.completionEvents.get(id)
  // Pushes the updated ciphertext for this event to the vault, so a fresh device
  // that has never seen the event receives the latest note on its first pull.
  // Devices that already hold the event keep their own copy: completion events
  // are insert-only, and applyRemoteEntity skips events already present locally.
  markDirty(evt?.sync_id)
}

export async function deleteCompletion(id: number): Promise<void> {
  const evt = await db.completionEvents.get(id)
  await db.completionEvents.delete(id)
  if (evt?.sync_id) {
    await writeTombstone(evt.sync_id)
    markDeleted(evt.sync_id)
  }
}

// Users

export async function getUsers(): Promise<User[]> {
  const users = await db.users.toArray()
  return users.sort((a, b) => a.name.localeCompare(b.name))
}

export async function createUser(name: string, syncId?: string): Promise<number> {
  const now = new Date().toISOString()
  const sync_id = syncId ?? crypto.randomUUID()
  const id = await db.users.add({
    name,
    sync_id,
    updated_at: now,
  } as User)
  markDirty(sync_id)
  return id
}

export async function updateUser(id: number, fields: { name: string }): Promise<void> {
  await db.users.update(id, { ...fields, updated_at: new Date().toISOString() })
  const user = await db.users.get(id)
  markDirty(user?.sync_id)
}

export async function deleteUser(id: number): Promise<void> {
  let deletedSyncId: string | undefined
  await db.transaction('rw', db.users, db.tombstones, async () => {
    const user = await db.users.get(id)
    await db.users.delete(id)
    if (user?.sync_id) {
      await writeTombstone(user.sync_id)
      deletedSyncId = user.sync_id
    }
  })
  markDeleted(deletedSyncId)
}

// Removes duplicate user rows that share the same sync_id, keeping the one
// with the most recent updated_at. Returns the number of rows deleted.
export async function deduplicateUsers(): Promise<number> {
  const all = await db.users.toArray()
  const bySyncId = new Map<string, typeof all>()
  for (const u of all) {
    const key = u.sync_id ?? ''
    const group = bySyncId.get(key) ?? []
    group.push(u)
    bySyncId.set(key, group)
  }
  let deleted = 0
  for (const group of bySyncId.values()) {
    if (group.length <= 1) continue
    group.sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
    const toDelete = group.slice(1)
    for (const u of toDelete) {
      await db.users.delete(u.id!)
      deleted++
    }
  }
  return deleted
}

// Backup / restore
//
// A backup is a full snapshot of the user's data. Two on-disk shapes exist and
// both are accepted on restore (see normalizeBackup):
//   • BackupPayload  — snake_case full Dexie rows, written by exportBackup() for
//     the in-app "Export to file" action.
//   • SyncPayload    — camelCase, sync_id-keyed, written by the sync engine to
//     the WebDAV backups/ folder (buildBackupPayload in src/sync/engine.ts).
// Restore keys off sync_id in either shape, so a file downloaded from the WebDAV
// backups folder imports as happily as an in-app export (issue #192).

const BACKUP_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface BackupPayload {
  version: number
  exportedAt: string
  categories: Category[]
  chores: Chore[]
  completionEvents: CompletionEvent[]
  users?: User[]
  settings?: { multiUserEnabled: boolean }
}

export async function exportBackup(): Promise<BackupPayload> {
  const [categories, chores, completionEvents, users] = await Promise.all([
    db.categories.toArray(),
    db.chores.toArray(),
    db.completionEvents.toArray(),
    db.users.toArray(),
  ])
  // version 2 adds users + settings so a file export is a complete snapshot and a
  // restore from it won't drop the roster.
  return {
    version: 2,
    exportedAt: new Date().toISOString(),
    categories,
    chores,
    completionEvents,
    users,
    settings: { multiUserEnabled: getMultiUserEnabled() },
  }
}

// ── Restore: format-tolerant normalization ────────────────────────────────────

interface NormalizedCategory { sync_id: string; name: string; sort_order: number; icon?: string; parent_sync_id: string | null; assigned_user_sync_ids: string[] }
interface NormalizedChore {
  sync_id: string; name: string; category_sync_id: string | null; sort_order: number
  target_cadence_days: number | null; notify_when_overdue: boolean; auto_schedule_to_dayglance: boolean
  preferred_schedule_behavior: Chore['preferred_schedule_behavior']
  seasonal_start: string | null; seasonal_end: string | null; icon?: string
  assigned_user_sync_ids: string[]; created_at: string
}
interface NormalizedEvent { sync_id: string; chore_sync_id: string; completed_at: string; note: string | null; source: 'manual' | 'dayglance'; completed_by_user_sync_id: string | null }
interface NormalizedUser { sync_id: string; name: string }
interface NormalizedBackup {
  categories: NormalizedCategory[]
  chores: NormalizedChore[]
  completionEvents: NormalizedEvent[]
  users: NormalizedUser[]
  hasUsers: boolean
  multiUserEnabled?: boolean
}

type Raw = Record<string, unknown>
const asNum = (v: unknown, d: number): number => (typeof v === 'number' ? v : d)
const asStr = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const asArr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [])

// Accept either backup shape and return one canonical, sync_id-keyed structure.
// References are resolved to sync_ids: from parent_sync_id/parentId, or — for very
// old exports that only carry numeric FKs — by mapping the legacy numeric id.
function normalizeBackup(raw: unknown, now: string): NormalizedBackup {
  const r = (raw ?? {}) as Raw
  const rawCats = Array.isArray(r.categories) ? (r.categories as Raw[]) : []
  const rawChores = Array.isArray(r.chores) ? (r.chores as Raw[]) : []
  const rawEvents = Array.isArray(r.completionEvents) ? (r.completionEvents as Raw[]) : []
  const rawUsers = Array.isArray(r.users) ? (r.users as Raw[]) : []

  // Pass 1 — every record gets a stable sync_id (camelCase uses `id`; snake_case
  // uses `sync_id`; ancient exports have neither → mint one), remembering legacy
  // numeric ids so numeric FKs can be relinked below.
  const catSyncByNum = new Map<number, string>()
  const catSyncIds = rawCats.map(c => {
    const sid = typeof c.sync_id === 'string' ? c.sync_id : typeof c.id === 'string' ? c.id : crypto.randomUUID()
    if (typeof c.id === 'number') catSyncByNum.set(c.id, sid)
    return sid
  })
  const choreSyncByNum = new Map<number, string>()
  const choreSyncIds = rawChores.map(c => {
    const sid = typeof c.sync_id === 'string' ? c.sync_id : typeof c.id === 'string' ? c.id : crypto.randomUUID()
    if (typeof c.id === 'number') choreSyncByNum.set(c.id, sid)
    return sid
  })

  const parentOf = (c: Raw): string | null => {
    if (typeof c.parent_sync_id === 'string') return c.parent_sync_id
    if (typeof c.parentId === 'string') return c.parentId
    if (typeof c.parent_category_id === 'number') return catSyncByNum.get(c.parent_category_id) ?? null
    return null
  }
  const choreCatOf = (c: Raw): string | null => {
    if (typeof c.category_sync_id === 'string') return c.category_sync_id
    if (typeof c.categorySyncId === 'string') return c.categorySyncId
    if (typeof c.category_id === 'number') return catSyncByNum.get(c.category_id) ?? null
    return null
  }
  const eventChoreOf = (e: Raw): string | undefined => {
    if (typeof e.chore_sync_id === 'string') return e.chore_sync_id
    if (typeof e.choreSyncId === 'string') return e.choreSyncId
    if (typeof e.chore_id === 'number') return choreSyncByNum.get(e.chore_id)
    return undefined
  }

  const categories = rawCats.map((c, i): NormalizedCategory => ({
    sync_id: catSyncIds[i],
    name: asStr(c.name),
    sort_order: asNum(c.sort_order ?? c.sortOrder, i),
    icon: typeof c.icon === 'string' ? c.icon : undefined,
    parent_sync_id: parentOf(c),
    assigned_user_sync_ids: asArr(c.assigned_user_sync_ids ?? c.assignedUserSyncIds),
  }))

  const chores = rawChores.map((c, i): NormalizedChore => ({
    sync_id: choreSyncIds[i],
    name: asStr(c.name),
    category_sync_id: choreCatOf(c),
    sort_order: asNum(c.sort_order ?? c.sortOrder, i),
    target_cadence_days: typeof (c.target_cadence_days ?? c.targetCadenceDays) === 'number' ? (c.target_cadence_days ?? c.targetCadenceDays) as number : null,
    notify_when_overdue: Boolean(c.notify_when_overdue ?? c.notifyWhenOverdue ?? false),
    auto_schedule_to_dayglance: Boolean(c.auto_schedule_to_dayglance ?? c.autoScheduleToDayglance ?? false),
    preferred_schedule_behavior: (c.preferred_schedule_behavior ?? c.preferredScheduleBehavior ?? null) as Chore['preferred_schedule_behavior'],
    seasonal_start: typeof (c.seasonal_start ?? c.seasonalStart) === 'string' ? (c.seasonal_start ?? c.seasonalStart) as string : null,
    seasonal_end: typeof (c.seasonal_end ?? c.seasonalEnd) === 'string' ? (c.seasonal_end ?? c.seasonalEnd) as string : null,
    icon: typeof c.icon === 'string' ? c.icon : undefined,
    assigned_user_sync_ids: asArr(c.assigned_user_sync_ids ?? c.assignedUserSyncIds),
    created_at: asStr(c.created_at ?? c.createdAt, now),
  }))

  const completionEvents = rawEvents
    .map((e): NormalizedEvent => ({
      sync_id: typeof e.sync_id === 'string' ? e.sync_id : typeof e.id === 'string' ? e.id : crypto.randomUUID(),
      chore_sync_id: eventChoreOf(e) ?? '',
      completed_at: asStr(e.completed_at ?? e.completedAt),
      note: typeof e.note === 'string' ? e.note : null,
      source: (e.source === 'dayglance' ? 'dayglance' : 'manual'),
      completed_by_user_sync_id: typeof (e.completed_by_user_sync_id ?? e.completedByUserSyncId) === 'string' ? (e.completed_by_user_sync_id ?? e.completedByUserSyncId) as string : null,
    }))
    .filter(e => e.chore_sync_id !== '')

  const users = rawUsers.map((u): NormalizedUser => ({
    sync_id: typeof u.sync_id === 'string' ? u.sync_id : typeof u.id === 'string' ? u.id : crypto.randomUUID(),
    name: asStr(u.name),
  }))

  const settings = r.settings as Raw | undefined
  const multiUserEnabled = settings && typeof settings.multiUserEnabled === 'boolean' ? settings.multiUserEnabled : undefined

  return { categories, chores, completionEvents, users, hasUsers: Array.isArray(r.users), multiUserEnabled }
}

function validateNormalizedBackup(b: NormalizedBackup): void {
  const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
  const mmddRe = /^\d{2}-\d{2}$/
  for (const c of b.categories) {
    if (!BACKUP_UUID_RE.test(c.sync_id)) throw new Error('invalid category sync_id')
    if (typeof c.name !== 'string' || c.name.length === 0 || c.name.length > 500) throw new Error('invalid category name')
    if (typeof c.sort_order !== 'number') throw new Error('invalid category sort_order')
  }
  for (const c of b.chores) {
    if (!BACKUP_UUID_RE.test(c.sync_id)) throw new Error('invalid chore sync_id')
    if (typeof c.name !== 'string' || c.name.length === 0 || c.name.length > 500) throw new Error('invalid chore name')
    if (typeof c.sort_order !== 'number') throw new Error('invalid chore sort_order')
    if (!isoRe.test(c.created_at)) throw new Error('invalid chore created_at')
    if (c.seasonal_start !== null && !mmddRe.test(c.seasonal_start)) throw new Error('invalid chore seasonal_start')
    if (c.seasonal_end !== null && !mmddRe.test(c.seasonal_end)) throw new Error('invalid chore seasonal_end')
  }
  for (const e of b.completionEvents) {
    if (!BACKUP_UUID_RE.test(e.sync_id)) throw new Error('invalid completionEvent sync_id')
    if (!BACKUP_UUID_RE.test(e.chore_sync_id)) throw new Error('invalid completionEvent chore link')
    if (!isoRe.test(e.completed_at)) throw new Error('invalid completionEvent completed_at')
  }
  for (const u of b.users) {
    if (!BACKUP_UUID_RE.test(u.sync_id)) throw new Error('invalid user sync_id')
    if (typeof u.name !== 'string' || u.name.length === 0 || u.name.length > 100) throw new Error('invalid user name')
  }
}

/**
 * Replace all local data with the backup, authoritatively.
 *
 * Accepts either on-disk backup shape. Restored rows are stamped with a fresh
 * updated_at (now) and marked dirty, and every entity that existed locally but is
 * absent from the backup is tombstoned. This is what makes a restore actually
 * stick under live cloud sync (issue #192): without the fresh timestamps the
 * merge is entity-grain last-writer-wins, so the server's newer copies would
 * overwrite the restore within seconds; without the tombstones, deleted rows
 * would sync straight back. On the next sync the whole account converges to the
 * backup. Completion-event history keeps its own completed_at (it is real data),
 * and chores keep their created_at. Throws on a completely empty backup so a
 * corrupt or truncated file can't silently wipe everything.
 */
export async function restoreFromBackup(raw: unknown): Promise<{ categories: number; chores: number; completionEvents: number }> {
  const now = new Date().toISOString()
  const b = normalizeBackup(raw, now)
  validateNormalizedBackup(b)

  if (b.categories.length === 0 && b.chores.length === 0 && b.completionEvents.length === 0 && b.users.length === 0) {
    throw new Error('empty backup')
  }

  let restoredSyncIds: string[] = []
  let tombstonedSyncIds: string[] = []

  await db.transaction('rw', [db.categories, db.chores, db.completionEvents, db.tombstones, db.users], async () => {
    // Snapshot what exists so we can tombstone whatever the backup omits.
    const [curCats, curChores, curEvts, curUsers] = await Promise.all([
      db.categories.toArray(), db.chores.toArray(), db.completionEvents.toArray(), db.users.toArray(),
    ])
    const existing = new Set<string>()
    for (const c of curCats) if (c.sync_id) existing.add(c.sync_id)
    for (const c of curChores) if (c.sync_id) existing.add(c.sync_id)
    for (const e of curEvts) if (e.sync_id) existing.add(e.sync_id)
    // Only diff users when the backup actually carries a roster; a v1 file export
    // has no users array, and restoring it must not wipe the existing roster.
    if (b.hasUsers) for (const u of curUsers) if (u.sync_id) existing.add(u.sync_id)

    const restored = new Set<string>()
    for (const c of b.categories) restored.add(c.sync_id)
    for (const c of b.chores) restored.add(c.sync_id)
    for (const e of b.completionEvents) restored.add(e.sync_id)
    for (const u of b.users) restored.add(u.sync_id)

    await db.completionEvents.clear()
    await db.chores.clear()
    await db.categories.clear()
    await db.tombstones.clear()
    if (b.hasUsers) await db.users.clear()

    // Categories — insert, then resolve parent_category_id from parent_sync_id.
    await db.categories.bulkAdd(b.categories.map(c => ({
      sync_id: c.sync_id, name: c.name, sort_order: c.sort_order, icon: c.icon,
      parent_sync_id: c.parent_sync_id, parent_category_id: undefined,
      updated_at: now, assigned_user_sync_ids: c.assigned_user_sync_ids,
    })) as Category[])
    const insertedCats = await db.categories.toArray()
    const catBySync = new Map(insertedCats.map(c => [c.sync_id, c]))
    for (const c of insertedCats) {
      if (!c.parent_sync_id) continue
      const parent = catBySync.get(c.parent_sync_id)
      if (parent) await db.categories.update(c.id!, { parent_category_id: parent.id })
    }

    // Chores — link to their category; drop any whose category is missing.
    const choreRows = b.chores
      .map(ch => {
        const cat = ch.category_sync_id ? catBySync.get(ch.category_sync_id) : undefined
        if (!cat) return null
        return {
          sync_id: ch.sync_id, name: ch.name, category_id: cat.id!, category_sync_id: ch.category_sync_id,
          sort_order: ch.sort_order, target_cadence_days: ch.target_cadence_days,
          notify_when_overdue: ch.notify_when_overdue, auto_schedule_to_dayglance: ch.auto_schedule_to_dayglance,
          preferred_schedule_behavior: ch.preferred_schedule_behavior,
          seasonal_start: ch.seasonal_start, seasonal_end: ch.seasonal_end, icon: ch.icon,
          assigned_user_sync_ids: ch.assigned_user_sync_ids, created_at: ch.created_at, updated_at: now,
        } as Chore
      })
      .filter((c): c is Chore => c !== null)
    await db.chores.bulkAdd(choreRows)
    const insertedChores = await db.chores.toArray()
    const choreBySync = new Map(insertedChores.map(c => [c.sync_id, c]))

    // Completion events — insert-only history; link to chore, drop orphans.
    const evtRows = b.completionEvents
      .map(e => {
        const chore = choreBySync.get(e.chore_sync_id)
        if (!chore) return null
        return {
          sync_id: e.sync_id, chore_id: chore.id!, completed_at: e.completed_at,
          note: e.note, source: e.source, completed_by_user_sync_id: e.completed_by_user_sync_id,
        } as CompletionEvent
      })
      .filter((e): e is CompletionEvent => e !== null)
    await db.completionEvents.bulkAdd(evtRows)

    if (b.hasUsers) {
      await db.users.bulkAdd(b.users.map(u => ({ sync_id: u.sync_id, name: u.name, updated_at: now })) as User[])
    }

    // Tombstone everything that existed before but the backup omits, so the
    // deletion propagates on the next sync instead of the old row syncing back.
    const removed = [...existing].filter(sid => !restored.has(sid) && BACKUP_UUID_RE.test(sid))
    if (removed.length) await db.tombstones.bulkPut(removed.map(sid => ({ id: sid, deleted_at: now })))

    restoredSyncIds = [...restored].filter(sid => BACKUP_UUID_RE.test(sid))
    tombstonedSyncIds = removed
  })

  if (b.multiUserEnabled !== undefined) setMultiUserEnabled(b.multiUserEnabled)

  // Restored rows carry `now` timestamps so they win last-writer-wins against any
  // live sync copy; tombstones do the same for deletions. Mark both so the active
  // transport uploads the restored state rather than pulling the old one back.
  for (const sid of restoredSyncIds) markDirty(sid)
  for (const sid of tombstonedSyncIds) markDeleted(sid)

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('lg:sync-applied'))
    window.dispatchEvent(new CustomEvent('lg:chore-logged'))
  }

  return { categories: b.categories.length, chores: b.chores.length, completionEvents: b.completionEvents.length }
}

// ── Seed data helpers ─────────────────────────────────────────────────────────

export async function hasSeedData(): Promise<boolean> {
  const count = await db.categories.where('sync_id').anyOf(SEED_CAT_SYNC_IDS).count()
  return count > 0
}

export async function seedChoresUsed(): Promise<boolean> {
  const choreIds = (
    await db.chores.where('sync_id').anyOf(SEED_CHORE_SYNC_IDS).primaryKeys()
  ) as number[]
  if (choreIds.length === 0) return false
  const count = await db.completionEvents.where('chore_id').anyOf(choreIds).count()
  return count > 0
}

export async function clearSeedData(): Promise<void> {
  const cats = await db.categories.where('sync_id').anyOf(SEED_CAT_SYNC_IDS).toArray()
  for (const cat of cats) {
    await deleteCategory(cat.id)
  }
}
