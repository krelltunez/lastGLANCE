import { describe, it, expect } from 'vitest'
import { collectPinned } from './pinned'
import type { CategoryWithChores } from '@/hooks/useChores'
import type { Category, ChoreWithLastCompletion } from '@/types'

let n = 0
function chore(p: Partial<ChoreWithLastCompletion> = {}): ChoreWithLastCompletion {
  n += 1
  return {
    id: n,
    name: `chore-${n}`,
    category_id: 1,
    sort_order: 0,
    target_cadence_days: 10,
    notify_when_overdue: false,
    auto_schedule_to_dayglance: false,
    preferred_schedule_behavior: null,
    seasonal_start: null,
    seasonal_end: null,
    details: null,
    pinned: true,
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    sync_id: `chore-sync-${n}`,
    category_sync_id: null,
    assigned_user_sync_ids: [],
    last_completed_at: '2024-01-01T00:00:00.000Z',
    elapsed_days: 0,
    ...p,
  }
}

function cat(name: string, chores: ChoreWithLastCompletion[], subcategories: CategoryWithChores[] = []): CategoryWithChores {
  n += 1
  const category = {
    id: n,
    name,
    sort_order: 0,
    sync_id: `cat-sync-${n}`,
    parent_sync_id: null,
    updated_at: '2024-01-01T00:00:00.000Z',
    assigned_user_sync_ids: [],
  } as Category
  return { category, chores, subcategories }
}

const names = (data: CategoryWithChores[]) => collectPinned(data).map(p => p.chore.name)

describe('collectPinned', () => {
  it('returns only pinned chores, with the category each lives in', () => {
    const data = [
      cat('Home', [chore({ name: 'Vacuum' }), chore({ name: 'Mop', pinned: false })]),
      cat('Car', [], [cat('Upkeep', [chore({ name: 'Oil change' })])]),
    ]
    expect(collectPinned(data).map(p => [p.chore.name, p.categoryName])).toEqual([
      ['Oil change', 'Upkeep'],
      ['Vacuum', 'Home'],
    ])
  })

  it('orders most overdue first, by elapsed / cadence rather than raw days', () => {
    const data = [cat('Home', [
      chore({ name: 'a', elapsed_days: 20, target_cadence_days: 100 }), // 0.2
      chore({ name: 'b', elapsed_days: 9, target_cadence_days: 3 }),    // 3.0
      chore({ name: 'c', elapsed_days: 12, target_cadence_days: 10 }),  // 1.2
    ])]
    expect(names(data)).toEqual(['b', 'c', 'a'])
  })

  it('puts chores without a ratio last, never-done and no-cadence alike, by name', () => {
    const data = [cat('Home', [
      chore({ name: 'z-no-cadence', target_cadence_days: null }),
      chore({ name: 'a-never-done', elapsed_days: null, last_completed_at: null }),
      chore({ name: 'fresh', elapsed_days: 0 }),
    ])]
    expect(names(data)).toEqual(['fresh', 'a-never-done', 'z-no-cadence'])
  })

  it('breaks ties by name so the order is stable', () => {
    const data = [cat('Home', [chore({ name: 'beta', elapsed_days: 5 }), chore({ name: 'alpha', elapsed_days: 5 })])]
    expect(names(data)).toEqual(['alpha', 'beta'])
  })

  it('leaves out pinned chores that are out of season', () => {
    // Today's date always falls outside a one-day window on the day before it.
    const d = new Date()
    d.setDate(d.getDate() - 1)
    const md = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const data = [cat('Yard', [
      chore({ name: 'Mow', seasonal_start: md, seasonal_end: md }),
      chore({ name: 'Rake' }),
    ])]
    expect(names(data)).toEqual(['Rake'])
  })

  it('is empty when nothing is pinned', () => {
    expect(collectPinned([cat('Home', [chore({ pinned: false })])])).toEqual([])
  })
})
