import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '@/db/client'
import { createCategory } from '@/db/queries'
import { buildIntentContext } from './intentContext'

function installBrowserStubs(): void {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  } as Storage
  const g = globalThis as { window?: unknown }
  if (!g.window) g.window = new EventTarget()
}
installBrowserStubs()

beforeEach(async () => {
  await Promise.all([db.categories.clear(), db.chores.clear()])
})

describe('intent CREATE into an existing category', () => {
  it('inherits the category’s assigned users', async () => {
    const categoryId = await createCategory('Yard', undefined, undefined, undefined, ['user-a', 'user-b'])
    const ctx = buildIntentContext()
    const created = await ctx.createChore!({ name: 'Mow lawn', categoryId })
    const chore = await db.chores.get(created.id)
    expect(chore?.assigned_user_sync_ids).toEqual(['user-a', 'user-b'])
  })

  it('leaves the chore unassigned when the category is unassigned', async () => {
    const categoryId = await createCategory('Kitchen')
    const ctx = buildIntentContext()
    const created = await ctx.createChore!({ name: 'Wipe counters', categoryId })
    const chore = await db.chores.get(created.id)
    expect(chore?.assigned_user_sync_ids).toEqual([])
  })
})
