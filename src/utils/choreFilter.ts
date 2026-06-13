import type { CategoryWithChores } from '@/hooks/useChores'
import type { ChoreWithLastCompletion } from '@/types'
import type { UserFilter } from '@/multiuser/settings'
import { needsAttention } from './cadence'

// "Owned by me" = unassigned (shared with everyone) or explicitly assigned to me.
export function ownedByMe(assigned: string[], meId: string): boolean {
  return assigned.length === 0 || assigned.includes(meId)
}

/**
 * Applies the "Mine" and "Soon" (attention) view filters to the category tree.
 *
 * - "Mine": a chore is visible if it's unassigned or assigned to me. A
 *   category/subcategory assigned to someone else suppresses its own direct
 *   chores, but subcategories are evaluated independently — so a parent owned
 *   by someone else still acts as a container for a subcategory that is mine.
 * - "Soon": a chore is visible only if it has aged into the amber/red zone.
 *
 * When either filter is active the tree is pruned: subcategories and categories
 * with nothing left to show are dropped. With no filter active the data is
 * returned untouched.
 */
export function filterCategoryData(
  data: CategoryWithChores[],
  meId: string | null,
  filter: UserFilter,
  attentionOnly: boolean,
): CategoryWithChores[] {
  const mineActive = filter === 'mine' && !!meId
  if (!mineActive && !attentionOnly) return data

  const choreVisible = (c: ChoreWithLastCompletion) => {
    if (mineActive && !ownedByMe(c.assigned_user_sync_ids, meId!)) return false
    if (attentionOnly && !needsAttention(c.target_cadence_days, c.elapsed_days)) return false
    return true
  }

  const visibleChores = (node: CategoryWithChores) => {
    if (mineActive && !ownedByMe(node.category.assigned_user_sync_ids, meId!)) return []
    return node.chores.filter(choreVisible)
  }

  const filtered = data.map(cat => ({
    ...cat,
    chores: visibleChores(cat),
    subcategories: cat.subcategories
      .map(sub => ({ ...sub, chores: visibleChores(sub) }))
      .filter(sub => sub.chores.length > 0),
  }))

  return filtered.filter(cat => cat.chores.length > 0 || cat.subcategories.length > 0)
}
