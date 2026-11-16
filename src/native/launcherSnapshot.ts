// The launcher snapshot (docs/launcher-integration.md): what the GLANCElauncher
// reads from lastGLANCE through the LauncherProvider. Its shape is the
// launcher's models, not the widgets': every chore and every person this user
// sees, with the ids the launcher writes back by. Pure, like peopleSnapshot.ts;
// hooks/useLauncherSnapshot.ts loads the data and pushes.
//
// A chore's `clientId` is the launcher's id for the write that created it,
// joined in from the handled-writes ledger rather than stored on the chore:
// lastGLANCE's sync tiers map chore fields one by one, so a field on the row
// would need both engines and both apply paths to learn it, and the ledger
// already carries the same fact on the device the write landed on.

import dayjs from 'dayjs'
import type { Category, ChoreWithLastCompletion } from '@/types'
import type { PersonCircle, PersonDate, PersonWithLastInteraction } from '@/people/types'
import { visibleToMe } from '@/people/home'
import { ownedByMe } from '@/utils/choreFilter'
import { isInSeasonalWindow } from '@/utils/seasonal'
import type { HandledWrite } from '@/intents/launcherWrites'

export const LAUNCHER_SNAPSHOT_VERSION = 1

export interface LauncherChore {
  id: string
  name: string
  category: string
  categoryId: string | null
  targetCadenceDays: number | null
  lastDoneAt: string | null
  elapsedDays: number | null
  icon: string | null
  updatedAt: string
  clientId: string | null
  // Shown in the launcher's Pinned list, as in the app's Pinned row and the
  // Pinned widgets. The launcher orders pins itself, the same way
  // collectPinned does. An older launcher ignores the field.
  pinned: boolean
  // The chore's season, "MM-DD" to "MM-DD" (a start after its end wraps the
  // new year), or null for a chore that is always in season. Only chores in
  // season at the build are listed at all; these let the launcher drop one
  // the day its season ends, without waiting for the next snapshot.
  seasonalStart: string | null
  seasonalEnd: string | null
}

export interface LauncherPersonDate {
  id: string
  kind: PersonDate['kind']
  label: string | null
  month: number
  day: number
  year: number | null
}

export interface LauncherPerson {
  id: string
  name: string
  nickname: string | null
  circle: string
  circleId: string | null
  targetCadenceDays: number | null
  lastInteractionAt: string | null
  lastChannel: string | null
  // They got in touch last and nothing has been logged back since.
  unreturned: boolean
  snoozedUntil: string | null
  dates: LauncherPersonDate[]
  updatedAt: string
}

export interface LauncherSnapshot {
  version: typeof LAUNCHER_SNAPSHOT_VERSION
  // Milliseconds since the epoch, the stamp the launcher shows staleness from.
  updatedAt: number
  timezone: string
  today: string
  chores: LauncherChore[]
  people: LauncherPerson[]
  handledWrites: HandledWrite[]
  // Chore completions per local day ("YYYY-MM-DD") over the last year, days
  // with none left out: what the app's own header heatmap is drawn from.
  // Every completion on the device counts, as in the app's heatmap, whoever
  // the chore belongs to.
  completionsByDay: Record<string, number>
}

// How far back `completionsByDay` reaches: the app's heatmap is 52 weeks
// from the start of a week, so 53 weeks covers it wherever the week starts.
export const LAUNCHER_ACTIVITY_DAYS = 53 * 7

export interface LauncherSnapshotInput {
  now: Date
  categories: Category[]
  chores: ChoreWithLastCompletion[]
  people: PersonWithLastInteraction[]
  dates: PersonDate[]
  circles: PersonCircle[]
  multiUserEnabled: boolean
  meId: string | null
  handledWrites: HandledWrite[]
  // Completions per local day, as getAllCompletionCounts answers them.
  completionCounts?: Map<string, number>
  timezone?: string
}

export function buildLauncherSnapshot(input: LauncherSnapshotInput): LauncherSnapshot {
  const { now, categories, people, dates, circles, multiUserEnabled, meId, handledWrites } = input
  const categoryById = new Map(categories.map(c => [c.id, c]))
  const circleName = new Map(circles.map(c => [c.sync_id, c.name]))
  const createdBy = new Map<string, string>()
  for (const w of handledWrites) {
    if (w.action === 'create' && w.entityId) createdBy.set(w.entityId, w.clientId)
  }

  // The same "Mine" rule as the widgets and the in-app list: with multi-user
  // on and a Me set, only chores owned by me, in categories not assigned away.
  const filterByMe = multiUserEnabled && !!meId
  const chores: LauncherChore[] = []
  const seen = new Set<string>()
  for (const ch of input.chores) {
    if (!ch.sync_id || seen.has(ch.sync_id)) continue
    const cat = categoryById.get(ch.category_id)
    if (filterByMe && (
      !ownedByMe(cat?.assigned_user_sync_ids ?? [], meId!) ||
      !ownedByMe(ch.assigned_user_sync_ids ?? [], meId!)
    )) continue
    // Out of season, a chore is not in the app's lists at all (CategorySection),
    // and the launcher has no business calling it due. Left out here, so that
    // holds for every launcher, including ones from before the season fields.
    if (!isInSeasonalWindow(ch, now)) continue
    seen.add(ch.sync_id)
    chores.push({
      id: ch.sync_id,
      name: ch.name,
      category: cat?.name ?? '',
      categoryId: cat?.sync_id ?? ch.category_sync_id ?? null,
      targetCadenceDays: ch.target_cadence_days,
      lastDoneAt: ch.last_completed_at,
      elapsedDays: ch.elapsed_days,
      icon: ch.icon ?? null,
      updatedAt: ch.updated_at,
      clientId: createdBy.get(ch.sync_id) ?? null,
      pinned: !!ch.pinned,
      seasonalStart: ch.seasonal_start && ch.seasonal_end ? ch.seasonal_start : null,
      seasonalEnd: ch.seasonal_start && ch.seasonal_end ? ch.seasonal_end : null,
    })
  }

  const datesByPerson = new Map<string, LauncherPersonDate[]>()
  for (const d of dates) {
    const list = datesByPerson.get(d.person_sync_id) ?? []
    list.push({ id: d.sync_id, kind: d.kind, label: d.label, month: d.month, day: d.day, year: d.year })
    datesByPerson.set(d.person_sync_id, list)
  }
  const mine = visibleToMe(people, multiUserEnabled, meId).filter(p => !p.archived)
  const launcherPeople: LauncherPerson[] = mine.map(p => ({
    id: p.sync_id,
    name: p.name,
    nickname: p.nickname,
    circle: (p.circle_sync_id && circleName.get(p.circle_sync_id)) || '',
    circleId: p.circle_sync_id,
    targetCadenceDays: p.target_cadence_days,
    lastInteractionAt: p.last_interaction_at,
    lastChannel: p.last_channel,
    unreturned: p.reciprocity.unreturned,
    snoozedUntil: p.snoozed_until,
    dates: datesByPerson.get(p.sync_id) ?? [],
    updatedAt: p.updated_at,
  }))

  // Sorted, so the same counts always make the same snapshot (the fingerprint).
  const since = dayjs(now).subtract(LAUNCHER_ACTIVITY_DAYS, 'day').format('YYYY-MM-DD')
  const completionsByDay: Record<string, number> = {}
  for (const [day, count] of [...(input.completionCounts ?? [])].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (day >= since && count > 0) completionsByDay[day] = count
  }

  return {
    version: LAUNCHER_SNAPSHOT_VERSION,
    updatedAt: now.getTime(),
    timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    today: dayjs(now).format('YYYY-MM-DD'),
    chores,
    people: launcherPeople,
    handledWrites,
    completionsByDay,
  }
}

// The snapshot's content without its stamp, so a push that would change nothing
// the launcher reads is skipped and `updatedAt` only moves on a real change.
export function launcherSnapshotFingerprint(snapshot: LauncherSnapshot): string {
  return JSON.stringify({ ...snapshot, updatedAt: 0 })
}
