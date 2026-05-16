import { db } from './client'
import type { Category, Chore, ChoreWithLastCompletion, CompletionEvent } from '@/types'
import dayjs from 'dayjs'

// Categories

export async function getCategories(): Promise<Category[]> {
  return db.categories.orderBy('sort_order').toArray()
}

export async function createCategory(name: string, sort_order?: number, icon?: string, parent_category_id?: number): Promise<number> {
  const order = sort_order ?? (await db.categories.count())
  return db.categories.add({ name, sort_order: order, icon, parent_category_id } as Category)
}

export async function updateCategory(id: number, fields: { name?: string; icon?: string; parent_category_id?: number | null }): Promise<void> {
  await db.categories.update(id, fields)
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
  await db.transaction('rw', db.categories, db.chores, db.completionEvents, async () => {
    const subcats = await db.categories.where('parent_category_id').equals(id).toArray()
    const catIds = [id, ...subcats.map(c => c.id!)]
    for (const catId of catIds) {
      const chores = await db.chores.where('category_id').equals(catId).toArray()
      await db.completionEvents.where('chore_id').anyOf(chores.map(c => c.id!)).delete()
      await db.chores.where('category_id').equals(catId).delete()
    }
    await db.categories.where('id').anyOf(subcats.map(c => c.id!)).delete()
    await db.categories.delete(id)
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
  data: Omit<Chore, 'id' | 'sort_order' | 'created_at' | 'updated_at'>
): Promise<number> {
  const now = dayjs().toISOString()
  const count = await db.chores.where('category_id').equals(data.category_id).count()
  return db.chores.add({ ...data, sort_order: count, created_at: now, updated_at: now } as Chore)
}

export async function reorderChores(orderedIds: number[]): Promise<void> {
  await db.transaction('rw', db.chores, () =>
    Promise.all(orderedIds.map((id, idx) => db.chores.update(id, { sort_order: idx })))
  )
}

export async function reorderCategories(orderedIds: number[]): Promise<void> {
  await db.transaction('rw', db.categories, () =>
    Promise.all(orderedIds.map((id, idx) => db.categories.update(id, { sort_order: idx })))
  )
}

export async function updateChore(
  id: number,
  data: Partial<Omit<Chore, 'id' | 'created_at' | 'updated_at'>> & { icon?: string }
): Promise<void> {
  await db.chores.update(id, { ...data, updated_at: dayjs().toISOString() })
}

export async function deleteChore(id: number): Promise<void> {
  await db.transaction('rw', db.chores, db.completionEvents, async () => {
    await db.completionEvents.where('chore_id').equals(id).delete()
    await db.chores.delete(id)
  })
}

// Completion events

export async function logCompletion(
  choreId: number,
  opts: { note?: string; completedAt?: string; source?: 'manual' | 'dayglance' } = {}
): Promise<number> {
  return db.completionEvents.add({
    chore_id: choreId,
    completed_at: opts.completedAt ?? dayjs().toISOString(),
    note: opts.note ?? null,
    source: opts.source ?? 'manual',
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

export async function deleteCompletion(id: number): Promise<void> {
  await db.completionEvents.delete(id)
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

export async function importBackup(payload: BackupPayload): Promise<void> {
  await db.transaction('rw', db.categories, db.chores, db.completionEvents, async () => {
    await db.completionEvents.clear()
    await db.chores.clear()
    await db.categories.clear()
    await db.categories.bulkAdd(payload.categories)
    await db.chores.bulkAdd(payload.chores)
    await db.completionEvents.bulkAdd(payload.completionEvents)
  })
}
