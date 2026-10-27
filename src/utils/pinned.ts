import type { CategoryWithChores } from '@/hooks/useChores'
import type { ChoreWithLastCompletion } from '@/types'
import { getFillRatio } from './cadence'
import { isInSeasonalWindow } from './seasonal'

export interface PinnedChore {
  chore: ChoreWithLastCompletion
  categoryName: string
}

// Elapsed / cadence, or null for chores with no colour (no cadence, or never
// done) — the same ratio the bars, the Soon filter and the widgets use.
function urgency(c: ChoreWithLastCompletion): number | null {
  if (c.target_cadence_days === null || c.elapsed_days === null) return null
  return getFillRatio(c.elapsed_days, c.target_cadence_days)
}

/**
 * The pinned chores in an (already filtered) category tree, most overdue
 * first. Chores without a ratio go last; ties fall back to name order so the
 * row doesn't reshuffle between renders.
 *
 * Takes the view the categories below are drawn from, so the Soon and Mine
 * filters apply to pins exactly as they do to everything else, and drops
 * out-of-season chores the way a category's non-edit list does.
 */
export function collectPinned(data: CategoryWithChores[]): PinnedChore[] {
  const out: PinnedChore[] = []
  const visit = (node: CategoryWithChores) => {
    for (const chore of node.chores) {
      if (chore.pinned && isInSeasonalWindow(chore)) out.push({ chore, categoryName: node.category.name })
    }
    node.subcategories.forEach(visit)
  }
  data.forEach(visit)

  return out.sort((a, b) => {
    const ra = urgency(a.chore)
    const rb = urgency(b.chore)
    if (ra !== rb) {
      if (ra === null) return 1
      if (rb === null) return -1
      return rb - ra
    }
    return a.chore.name.localeCompare(b.chore.name)
  })
}
