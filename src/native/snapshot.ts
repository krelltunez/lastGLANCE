import { getCategories, getChoresForCategory, getAllCompletionCounts } from '@/db/queries'
import { getFillRatio, getCadenceColor, needsAttention } from '@/utils/cadence'
import { getMeUserSyncId, getMultiUserEnabled } from '@/multiuser/settings'
import { ownedByMe } from '@/utils/choreFilter'
import { isInSeasonalWindow } from '@/utils/seasonal'
import { pushWidgetSnapshot } from './widgetBridge'
import { buildPeopleSnapshot, type PeopleSnapshot } from './peopleSnapshot'
import { getAllPersonDates, getPeople } from '@/people/queries'
import { visibleToMe } from '@/people/home'
import { isReciprocityShown } from '@/people/settings'
// The bare singleton, as in reminders.ts: '@/i18n' boots the detector and
// HTTP backend as an import side effect.
import i18n from 'i18next'
import dayjs from 'dayjs'
import { firstDayOfWeek } from '@/utils/datetime'

// How many days of completion history to ship to the heatmap widget.
// 53 weeks, so the widest grid we render (the 52-week iOS extra-large widget) is
// fully covered even after the alignment walk back to the oldest visible week start.
// Android's 26-week grid and the iOS medium widget read the same map and simply
// ignore the older half.
//
// Cost is bounded by activity, not by the window: only days that actually have
// completions are serialized, so this grows the snapshot by however many extra
// active days a user has, not by 181 entries.
const HEATMAP_DAYS = 371

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
  // Shown in the Pinned widgets: pinned and in season, as in the app's Pinned
  // row. Absent from snapshots written before pinning; widgets read that as
  // false. The widgets order pins themselves, the same way collectPinned does.
  pinned: boolean
}

export interface WidgetSnapshot {
  version: 1
  generatedAt: string
  counts: { overdue: number; soon: number }
  heatmap: Record<string, number>
  // The heatmap grid's first row, 0 = Sunday … 6 = Saturday: the app's own
  // resolved week start, so the widgets line up with the in-app grid (issue
  // #362). Widgets fall back to the system calendar when it is absent.
  weekStart: number
  chores: SnapshotChore[]
  // Added with the People widgets; widgets from before simply ignore it, and
  // the People widgets treat its absence as empty.
  people: PeopleSnapshot
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

  // Mirror the in-app "Mine" semantics (and useNotifications): when multi-user is
  // on and a "Me" is set, the widgets show only chores owned by me — unassigned
  // or assigned to me, and not inside a category assigned to someone else.
  const meId = getMeUserSyncId()
  const filterByMe = getMultiUserEnabled() && !!meId
  const categoryById = new Map(categories.map(c => [c.id, c]))

  const chores: SnapshotChore[] = []
  let overdue = 0
  let soon = 0

  for (const list of choresByCat) {
    for (const ch of list) {
      if (filterByMe) {
        const cat = categoryById.get(ch.category_id)
        if (!ownedByMe(cat?.assigned_user_sync_ids ?? [], meId!) ||
            !ownedByMe(ch.assigned_user_sync_ids ?? [], meId!)) {
          continue
        }
      }
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
        pinned: !!ch.pinned && isInSeasonalWindow(ch),
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

  // People, as this user sees them (household members' People stay hidden).
  const [people, dates] = await Promise.all([getPeople(), getAllPersonDates()])
  const mine = visibleToMe(people, getMultiUserEnabled(), meId)

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    counts: { overdue, soon },
    heatmap,
    weekStart: firstDayOfWeek(),
    chores,
    people: buildPeopleSnapshot(i18n.t.bind(i18n), mine, dates, dayjs(), isReciprocityShown()),
  }
}

// Build the snapshot and hand it to native. Safe to call anywhere; no-ops on
// web/PWA and never throws.
export async function pushSnapshot(): Promise<void> {
  try {
    const snapshot = await buildSnapshot()
    await pushWidgetSnapshot(JSON.stringify(snapshot))
  } catch {
    // Snapshot generation is best-effort; failures must not affect the app.
  }
}
