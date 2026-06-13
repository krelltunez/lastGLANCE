import { describe, it, expect } from 'vitest'
import { filterCategoryData, ownedByMe } from './choreFilter'
import type { CategoryWithChores } from '@/hooks/useChores'
import type { Category, ChoreWithLastCompletion } from '@/types'

const ME = 'me'
const OTHER = 'other'

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
    created_at: '2024-01-01T00:00:00.000Z',
    updated_at: '2024-01-01T00:00:00.000Z',
    sync_id: `chore-sync-${n}`,
    category_sync_id: null,
    assigned_user_sync_ids: [],
    last_completed_at: null,
    elapsed_days: 0,
    ...p,
  }
}

function cat(
  assigned: string[],
  chores: ChoreWithLastCompletion[],
  subcategories: CategoryWithChores[] = [],
): CategoryWithChores {
  n += 1
  const category = {
    id: n,
    name: `cat-${n}`,
    sort_order: 0,
    sync_id: `cat-sync-${n}`,
    parent_sync_id: null,
    updated_at: '2024-01-01T00:00:00.000Z',
    assigned_user_sync_ids: assigned,
  } as Category
  return { category, chores, subcategories }
}

describe('ownedByMe', () => {
  it('treats unassigned as shared (owned by everyone)', () => {
    expect(ownedByMe([], ME)).toBe(true)
  })
  it('matches when assigned to me', () => {
    expect(ownedByMe([ME], ME)).toBe(true)
    expect(ownedByMe([OTHER, ME], ME)).toBe(true)
  })
  it('does not match when assigned only to others', () => {
    expect(ownedByMe([OTHER], ME)).toBe(false)
  })
})

describe('filterCategoryData', () => {
  it('returns data untouched with no active filter', () => {
    const data = [cat([], [chore()])]
    expect(filterCategoryData(data, ME, 'all', false)).toBe(data)
  })

  it('Mine: hides chores assigned to others, keeps shared and mine', () => {
    const data = [cat([], [
      chore({ assigned_user_sync_ids: [OTHER] }),
      chore({ assigned_user_sync_ids: [ME] }),
      chore({ assigned_user_sync_ids: [] }),
    ])]
    const out = filterCategoryData(data, ME, 'mine', false)
    expect(out[0].chores).toHaveLength(2)
  })

  it('Mine: prunes a shared category whose chores are all someone else\'s', () => {
    const data = [cat([], [chore({ assigned_user_sync_ids: [OTHER] })])]
    expect(filterCategoryData(data, ME, 'mine', false)).toHaveLength(0)
  })

  it('Mine: prunes my own category when it has no visible chores', () => {
    const data = [cat([ME], [])]
    expect(filterCategoryData(data, ME, 'mine', false)).toHaveLength(0)
  })

  it('Mine: a category assigned to others suppresses its own chores', () => {
    const data = [cat([OTHER], [chore({ assigned_user_sync_ids: [] })])]
    expect(filterCategoryData(data, ME, 'mine', false)).toHaveLength(0)
  })

  it('Mine: parent owned by other still reveals my subcategory', () => {
    const mySub = cat([ME], [chore({ assigned_user_sync_ids: [] })])
    const data = [cat([OTHER], [chore({ assigned_user_sync_ids: [] })], [mySub])]
    const out = filterCategoryData(data, ME, 'mine', false)
    expect(out).toHaveLength(1)
    expect(out[0].chores).toHaveLength(0)        // parent's own chores suppressed
    expect(out[0].subcategories).toHaveLength(1) // my subcategory kept
  })

  it('Mine: hides a subcategory assigned to someone else', () => {
    const theirSub = cat([OTHER], [chore({ assigned_user_sync_ids: [] })])
    const data = [cat([], [chore({ assigned_user_sync_ids: [ME] })], [theirSub])]
    const out = filterCategoryData(data, ME, 'mine', false)
    expect(out).toHaveLength(1)
    expect(out[0].subcategories).toHaveLength(0)
  })

  it('Soon: keeps only amber/red chores and ignores assignment', () => {
    const data = [cat([], [
      chore({ target_cadence_days: 10, elapsed_days: 8, assigned_user_sync_ids: [OTHER] }), // ratio 0.8 → attention
      chore({ target_cadence_days: 10, elapsed_days: 2 }),                                  // ratio 0.2 → no
    ])]
    const out = filterCategoryData(data, ME, 'all', true)
    expect(out[0].chores).toHaveLength(1)
    expect(out[0].chores[0].elapsed_days).toBe(8)
  })

  it('Soon: prunes categories with nothing aging', () => {
    const data = [cat([], [chore({ target_cadence_days: 10, elapsed_days: 1 })])]
    expect(filterCategoryData(data, ME, 'all', true)).toHaveLength(0)
  })

  it('Mine + Soon: applies both (mine ownership and attention)', () => {
    const data = [cat([], [
      chore({ assigned_user_sync_ids: [ME], target_cadence_days: 10, elapsed_days: 9 }),    // mine + amber → keep
      chore({ assigned_user_sync_ids: [ME], target_cadence_days: 10, elapsed_days: 1 }),    // mine but fresh → drop
      chore({ assigned_user_sync_ids: [OTHER], target_cadence_days: 10, elapsed_days: 9 }), // amber but not mine → drop
    ])]
    const out = filterCategoryData(data, ME, 'mine', true)
    expect(out[0].chores).toHaveLength(1)
    expect(out[0].chores[0].elapsed_days).toBe(9)
  })
})
