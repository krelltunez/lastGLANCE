import { db, SEED_CAT_SYNC_IDS, SEED_CHORE_SYNC_IDS } from './client'
import type { Category, Chore, ChoreWithLastCompletion, CompletionEvent, User } from '@/types'
import dayjs from 'dayjs'

// Tombstone helpers

async function writeTombstone(syncId: string): Promise<void> {
  await db.tombstones.put({ id: syncId, deleted_at: new Date().toISOString() })
}

// Categories

export async function getCategories(): Promise<Category[]> {
  return db.categories.orderBy('sort_order').toArray()
}

export async function createCategory(name: string, sort_order?: number, icon?: string, parent_category_id?: number): Promise<number> {
  const order = sort_order ?? (await db.categories.count())
  let parent_sync_id: string | null = null
  if (parent_category_id) {
    const parent = await db.categories.get(parent_category_id)
    parent_sync_id = parent?.sync_id ?? null
  }
  return db.categories.add({
    name,
    sort_order: order,
    icon,
    parent_category_id,
    sync_id: crypto.randomUUID(),
    parent_sync_id,
    updated_at: new Date().toISOString(),
  } as Category)
}

export async function updateCategory(id: number, fields: { name?: string; icon?: string; parent_category_id?: number | null }): Promise<void> {
  const { parent_category_id, ...simpleFields } = fields
  const updated_at = new Date().toISOString()
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
  })
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
  return db.chores.add({
    ...data,
    sort_order: count,
    created_at: now,
    updated_at: now,
    sync_id: crypto.randomUUID(),
    category_sync_id,
  } as Chore)
}

export async function reorderChores(orderedIds: number[]): Promise<void> {
  await db.transaction('rw', db.chores, () =>
    Promise.all(orderedIds.map((id, idx) => db.chores.update(id, { sort_order: idx, updated_at: dayjs().toISOString() })))
  )
}

export async function reorderCategories(orderedIds: number[]): Promise<void> {
  await db.transaction('rw', db.categories, () =>
    Promise.all(orderedIds.map((id, idx) => db.categories.update(id, { sort_order: idx, updated_at: dayjs().toISOString() })))
  )
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
}

export async function deleteChore(id: number): Promise<void> {
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
  })
}

// Completion events

export async function logCompletion(
  choreId: number,
  opts: { note?: string; completedAt?: string; source?: 'manual' | 'dayglance'; completedByUserSyncId?: string | null; syncId?: string } = {}
): Promise<number> {
  return db.completionEvents.add({
    chore_id: choreId,
    completed_at: opts.completedAt ?? dayjs().toISOString(),
    note: opts.note ?? null,
    source: opts.source ?? 'manual',
    completed_by_user_sync_id: opts.completedByUserSyncId ?? null,
    sync_id: opts.syncId ?? crypto.randomUUID(),
  } as CompletionEvent)
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
}

export async function deleteCompletion(id: number): Promise<void> {
  const evt = await db.completionEvents.get(id)
  await db.completionEvents.delete(id)
  if (evt?.sync_id) {
    await writeTombstone(evt.sync_id)
  }
}

// Users

export async function getUsers(): Promise<User[]> {
  const users = await db.users.toArray()
  return users.sort((a, b) => a.name.localeCompare(b.name))
}

export async function createUser(name: string, syncId?: string): Promise<number> {
  const now = new Date().toISOString()
  return db.users.add({
    name,
    sync_id: syncId ?? crypto.randomUUID(),
    updated_at: now,
  } as User)
}

export async function updateUser(id: number, fields: { name: string }): Promise<void> {
  await db.users.update(id, { ...fields, updated_at: new Date().toISOString() })
}

export async function deleteUser(id: number): Promise<void> {
  await db.transaction('rw', db.users, db.tombstones, async () => {
    const user = await db.users.get(id)
    await db.users.delete(id)
    if (user?.sync_id) {
      await writeTombstone(user.sync_id)
    }
  })
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

export interface BackupPayload {
  version: number
  exportedAt: string
  categories: Category[]
  chores: Chore[]
  completionEvents: CompletionEvent[]
}

export async function exportBackup(): Promise<BackupPayload> {
  const [categories, chores, completionEvents] = await Promise.all([
    db.categories.toArray(),
    db.chores.toArray(),
    db.completionEvents.toArray(),
  ])
  return { version: 1, exportedAt: new Date().toISOString(), categories, chores, completionEvents }
}

function validateBackupPayload(payload: BackupPayload): void {
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
  const mmddRe = /^\d{2}-\d{2}$/
  for (const c of payload.categories) {
    if (typeof c.name !== 'string' || c.name.length === 0 || c.name.length > 500) throw new Error('invalid category name')
    if (typeof c.sort_order !== 'number') throw new Error('invalid category sort_order')
    if (c.sync_id !== undefined && !uuidRe.test(c.sync_id)) throw new Error('invalid category sync_id')
    if (c.updated_at !== undefined && !isoRe.test(c.updated_at)) throw new Error('invalid category updated_at')
  }
  for (const c of payload.chores) {
    if (typeof c.name !== 'string' || c.name.length === 0 || c.name.length > 500) throw new Error('invalid chore name')
    if (typeof c.sort_order !== 'number') throw new Error('invalid chore sort_order')
    if (c.sync_id !== undefined && !uuidRe.test(c.sync_id)) throw new Error('invalid chore sync_id')
    if (!isoRe.test(c.created_at)) throw new Error('invalid chore created_at')
    if (!isoRe.test(c.updated_at)) throw new Error('invalid chore updated_at')
    if (c.seasonal_start !== null && c.seasonal_start !== undefined && !mmddRe.test(c.seasonal_start)) throw new Error('invalid chore seasonal_start')
    if (c.seasonal_end !== null && c.seasonal_end !== undefined && !mmddRe.test(c.seasonal_end)) throw new Error('invalid chore seasonal_end')
  }
  for (const e of payload.completionEvents) {
    if (e.sync_id !== undefined && !uuidRe.test(e.sync_id)) throw new Error('invalid completionEvent sync_id')
    if (!isoRe.test(e.completed_at)) throw new Error('invalid completionEvent completed_at')
    if (e.source !== 'manual' && e.source !== 'dayglance') throw new Error('invalid completionEvent source')
  }
}

export async function importBackup(payload: BackupPayload): Promise<void> {
  validateBackupPayload(payload)
  await db.transaction('rw', db.categories, db.chores, db.completionEvents, db.tombstones, async () => {
    await db.completionEvents.clear()
    await db.chores.clear()
    await db.categories.clear()
    await db.tombstones.clear()
    const now = new Date().toISOString()
    // Backfill sync_ids for records that may lack them (pre-v5 backups)
    const categories = payload.categories.map(c => ({
      ...c,
      sync_id: c.sync_id ?? crypto.randomUUID(),
      parent_sync_id: c.parent_sync_id ?? null,
      updated_at: c.updated_at ?? now,
    }))
    const chores = payload.chores.map(c => ({
      ...c,
      sync_id: c.sync_id ?? crypto.randomUUID(),
      category_sync_id: c.category_sync_id ?? null,
    }))
    const completionEvents = payload.completionEvents.map(e => ({
      ...e,
      sync_id: e.sync_id ?? crypto.randomUUID(),
    }))
    await db.categories.bulkAdd(categories)
    await db.chores.bulkAdd(chores)
    await db.completionEvents.bulkAdd(completionEvents)
  })
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
