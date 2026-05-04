import { db } from './client'
import type { Category, Chore, ChoreWithLastCompletion, CompletionEvent } from '@/types'
import dayjs from 'dayjs'

// Categories

export async function getCategories(): Promise<Category[]> {
  return db.categories.orderBy('sort_order').toArray()
}

export async function createCategory(name: string, sort_order?: number): Promise<number> {
  const order = sort_order ?? (await db.categories.count())
  return db.categories.add({ name, sort_order: order } as Category)
}

export async function updateCategory(id: number, name: string): Promise<void> {
  await db.categories.update(id, { name })
}

export async function deleteCategory(id: number): Promise<void> {
  await db.transaction('rw', db.categories, db.chores, db.completionEvents, async () => {
    const chores = await db.chores.where('category_id').equals(id).toArray()
    await db.completionEvents.where('chore_id').anyOf(chores.map(c => c.id!)).delete()
    await db.chores.where('category_id').equals(id).delete()
    await db.categories.delete(id)
  })
}

// Chores

export async function getChoresForCategory(categoryId: number): Promise<ChoreWithLastCompletion[]> {
  const chores = await db.chores.where('category_id').equals(categoryId).sortBy('name')

  return Promise.all(
    chores.map(async chore => {
      const last = await db.completionEvents
        .where('chore_id')
        .equals(chore.id!)
        .reverse()
        .sortBy('completed_at')
        .then(evts => evts[0] ?? null)

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
  data: Omit<Chore, 'id' | 'created_at' | 'updated_at'>
): Promise<number> {
  const now = dayjs().toISOString()
  return db.chores.add({ ...data, created_at: now, updated_at: now } as Chore)
}

export async function updateChore(
  id: number,
  data: Partial<Omit<Chore, 'id' | 'created_at' | 'updated_at'>>
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
    .reverse()
    .sortBy('completed_at')
    .then(evts => evts.slice(0, limit))
}

export async function deleteCompletion(id: number): Promise<void> {
  await db.completionEvents.delete(id)
}
