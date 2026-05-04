import { getDB } from './client'
import type { Category, Chore, ChoreWithLastCompletion, CompletionEvent } from '@/types'
import dayjs from 'dayjs'

// Categories

export async function getCategories(): Promise<Category[]> {
  const db = await getDB()
  return db.selectObjects('SELECT * FROM categories ORDER BY sort_order, name') as unknown as Category[]
}

export async function createCategory(name: string, sort_order?: number): Promise<number> {
  const db = await getDB()
  const order = sort_order ?? (db.selectValue('SELECT COALESCE(MAX(sort_order)+1,0) FROM categories') as number)
  db.exec({ sql: 'INSERT INTO categories(name, sort_order) VALUES(?,?)', bind: [name, order] })
  return db.selectValue('SELECT last_insert_rowid()') as number
}

export async function updateCategory(id: number, name: string): Promise<void> {
  const db = await getDB()
  db.exec({ sql: 'UPDATE categories SET name=? WHERE id=?', bind: [name, id] })
}

export async function deleteCategory(id: number): Promise<void> {
  const db = await getDB()
  db.exec({ sql: 'DELETE FROM categories WHERE id=?', bind: [id] })
}

// Chores

type RawChoreRow = Omit<ChoreWithLastCompletion, 'auto_schedule_to_dayglance'> & {
  auto_schedule_to_dayglance: number
}

export async function getChoresForCategory(categoryId: number): Promise<ChoreWithLastCompletion[]> {
  const db = await getDB()
  const rows = db.selectObjects(
    `SELECT
        c.*,
        ce.completed_at AS last_completed_at,
        CASE
          WHEN ce.completed_at IS NULL THEN NULL
          ELSE ROUND((julianday('now') - julianday(ce.completed_at)), 1)
        END AS elapsed_days
      FROM chores c
      LEFT JOIN (
        SELECT chore_id, MAX(completed_at) AS completed_at
        FROM completion_events
        GROUP BY chore_id
      ) ce ON ce.chore_id = c.id
      WHERE c.category_id = ?
      ORDER BY c.name`,
    [categoryId],
  ) as unknown as RawChoreRow[]

  return rows.map(r => ({
    ...r,
    auto_schedule_to_dayglance: Boolean(r.auto_schedule_to_dayglance),
  }))
}

export async function createChore(
  data: Omit<Chore, 'id' | 'created_at' | 'updated_at'>
): Promise<number> {
  const db = await getDB()
  const now = dayjs().toISOString()
  db.exec({
    sql: `INSERT INTO chores(name, category_id, target_cadence_days, auto_schedule_to_dayglance, preferred_schedule_behavior, created_at, updated_at)
          VALUES(?,?,?,?,?,?,?)`,
    bind: [
      data.name,
      data.category_id,
      data.target_cadence_days ?? null,
      data.auto_schedule_to_dayglance ? 1 : 0,
      data.preferred_schedule_behavior ?? null,
      now,
      now,
    ],
  })
  return db.selectValue('SELECT last_insert_rowid()') as number
}

export async function updateChore(
  id: number,
  data: Partial<Omit<Chore, 'id' | 'created_at' | 'updated_at'>>
): Promise<void> {
  const db = await getDB()
  const now = dayjs().toISOString()
  const fields: string[] = []
  const values: (string | number | null)[] = []

  if (data.name !== undefined) { fields.push('name=?'); values.push(data.name) }
  if (data.target_cadence_days !== undefined) { fields.push('target_cadence_days=?'); values.push(data.target_cadence_days) }
  if (data.auto_schedule_to_dayglance !== undefined) { fields.push('auto_schedule_to_dayglance=?'); values.push(data.auto_schedule_to_dayglance ? 1 : 0) }
  if (data.preferred_schedule_behavior !== undefined) { fields.push('preferred_schedule_behavior=?'); values.push(data.preferred_schedule_behavior) }

  if (fields.length === 0) return
  fields.push('updated_at=?'); values.push(now)
  values.push(id)

  db.exec({ sql: `UPDATE chores SET ${fields.join(',')} WHERE id=?`, bind: values })
}

export async function deleteChore(id: number): Promise<void> {
  const db = await getDB()
  db.exec({ sql: 'DELETE FROM chores WHERE id=?', bind: [id] })
}

// Completion events

export async function logCompletion(
  choreId: number,
  opts: { note?: string; completedAt?: string; source?: 'manual' | 'dayglance' } = {}
): Promise<number> {
  const db = await getDB()
  const completedAt = opts.completedAt ?? dayjs().toISOString()
  db.exec({
    sql: 'INSERT INTO completion_events(chore_id, completed_at, note, source) VALUES(?,?,?,?)',
    bind: [choreId, completedAt, opts.note ?? null, opts.source ?? 'manual'],
  })
  return db.selectValue('SELECT last_insert_rowid()') as number
}

export async function getCompletionHistory(
  choreId: number,
  limit = 50
): Promise<CompletionEvent[]> {
  const db = await getDB()
  return db.selectObjects(
    'SELECT * FROM completion_events WHERE chore_id=? ORDER BY completed_at DESC LIMIT ?',
    [choreId, limit],
  ) as unknown as CompletionEvent[]
}

export async function deleteCompletion(id: number): Promise<void> {
  const db = await getDB()
  db.exec({ sql: 'DELETE FROM completion_events WHERE id=?', bind: [id] })
}
