import { getCategories, getChoresForCategory, getAllCompletionCounts } from '@/db/queries'
import { getFillRatio, getCadenceColor, needsAttention } from '@/utils/cadence'
import { pushWidgetSnapshot } from './widgetBridge'
import dayjs from 'dayjs'

// How many days of completion history to ship to the heatmap widget.
const HEATMAP_DAYS = 120

export type ChoreState = 'fresh' | 'soon' | 'overdue' | 'none'

export interface SnapshotChore {
  syncId: string
  name: string
  icon: string | null
  categoryName: string | null
  lastCompletedAt: string | null
  elapsedDays: number | null
  targetCadenceDays: number | null
  ratio: number | null
  color: string | null
  state: ChoreState
}

export interface WidgetSnapshot {
  version: 1
  generatedAt: string
  counts: { overdue: number; soon: number }
  heatmap: Record<string, number>
  chores: SnapshotChore[]
}

function choreState(target: number | null, elapsed: number | null): ChoreState {
  if (target == null || elapsed == null) return 'none'
  if (getFillRatio(elapsed, target) >= 1) return 'overdue'
  if (needsAttention(target, elapsed)) return 'soon'
  return 'fresh'
}

export async function buildSnapshot(): Promise<WidgetSnapshot> {
  const categories = await getCategories()
  const choresByCat = await Promise.all(categories.map(c => getChoresForCategory(c.id)))
  const catName = new Map(categories.map(c => [c.id, c.name]))

  const chores: SnapshotChore[] = []
  let overdue = 0
  let soon = 0

  for (const list of choresByCat) {
    for (const ch of list) {
      const state = choreState(ch.target_cadence_days, ch.elapsed_days)
      if (state === 'overdue') overdue++
      else if (state === 'soon') soon++

      const ratio =
        ch.target_cadence_days != null && ch.elapsed_days != null
          ? getFillRatio(ch.elapsed_days, ch.target_cadence_days)
          : null

      chores.push({
        syncId: ch.sync_id,
        name: ch.name,
        icon: ch.icon ?? null,
        categoryName: catName.get(ch.category_id) ?? null,
        lastCompletedAt: ch.last_completed_at,
        elapsedDays: ch.elapsed_days,
        targetCadenceDays: ch.target_cadence_days,
        ratio: ratio != null ? Math.round(ratio * 100) / 100 : null,
        color: ratio != null ? getCadenceColor(ratio) : null,
        state,
      })
    }
  }

  // Trim the global completion counts to the heatmap window.
  const counts = await getAllCompletionCounts()
  const cutoff = dayjs().subtract(HEATMAP_DAYS - 1, 'day').startOf('day')
  const heatmap: Record<string, number> = {}
  for (const [date, n] of counts) {
    if (!dayjs(date).isBefore(cutoff)) heatmap[date] = n
  }

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    counts: { overdue, soon },
    heatmap,
    chores,
  }
}

// Build the snapshot and hand it to native. Safe to call anywhere; no-ops off
// Android and never throws.
export async function pushSnapshot(): Promise<void> {
  try {
    const snapshot = await buildSnapshot()
    await pushWidgetSnapshot(JSON.stringify(snapshot))
  } catch {
    // Snapshot generation is best-effort; failures must not affect the app.
  }
}
