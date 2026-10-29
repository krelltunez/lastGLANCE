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
  // Shown in the launcher's Pinned list: pinned and in season, as in the app's
  // Pinned row and the Pinned widgets. The launcher orders pins itself, the
  // same way collectPinned does. An older launcher ignores the field.
  pinned: boolean
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
}

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
      pinned: !!ch.pinned && isInSeasonalWindow(ch, now),
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

  return {
    version: LAUNCHER_SNAPSHOT_VERSION,
    updatedAt: now.getTime(),
    timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    today: dayjs(now).format('YYYY-MM-DD'),
    chores,
    people: launcherPeople,
    handledWrites,
  }
}

// The snapshot's content without its stamp, so a push that would change nothing
// the launcher reads is skipped and `updatedAt` only moves on a real change.
export function launcherSnapshotFingerprint(snapshot: LauncherSnapshot): string {
  return JSON.stringify({ ...snapshot, updatedAt: 0 })
}
