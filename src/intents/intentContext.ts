// Wires the pure handleIntent() to lastGLANCE's real DB, navigation, and the
// outbound NOTIFY broadcast. Kept separate from the transport hook so the hook
// stays thin and this glue is importable/testable on its own.

import dayjs from 'dayjs'
import { db } from '@/db/client'
import { getCategories, createCategory, createChore as dbCreateChore, logCompletion as dbLogCompletion } from '@/db/queries'
import { getMeUserSyncId } from '@/multiuser/settings'
import { addActivityEntry } from './config'
import { nativeSendNotifyBroadcast } from '@/native/intentsBridge'
import type { IntentChore, IntentContext, OpenTarget } from './handleIntent'
import { ACTIONS, EVENTS, SOURCE_APPS, eventId } from '@glance-apps/intents'

// The category intent-created chores land in when the CREATE payload names no
// `project` (or names one that doesn't exist and we fall through to a default).
const INBOX_CATEGORY_NAME = 'Inbox'

// Loads every chore with its computed `elapsed_days` (age since last completion),
// the same derivation getChoresForCategory uses, but across all categories in a
// single pass over completionEvents.
async function listChores(): Promise<IntentChore[]> {
  const [chores, events] = await Promise.all([db.chores.toArray(), db.completionEvents.toArray()])
  const lastByChore = new Map<number, string>()
  for (const evt of events) {
    const prev = lastByChore.get(evt.chore_id)
    if (!prev || evt.completed_at.localeCompare(prev) > 0) lastByChore.set(evt.chore_id, evt.completed_at)
  }
  return chores.map(c => {
    const last = c.id != null ? lastByChore.get(c.id) : undefined
    const elapsed = last ? dayjs().diff(dayjs(last), 'minute') / (60 * 24) : null
    return {
      id: c.id!,
      sync_id: c.sync_id,
      name: c.name,
      category_id: c.category_id,
      target_cadence_days: c.target_cadence_days,
      elapsed_days: elapsed !== null ? Math.round(elapsed * 10) / 10 : null,
    }
  })
}

// Finds a category by name (case-insensitive), creating it if absent. A null
// name (no `project` in the payload) resolves the shared Inbox category.
async function ensureCategory(name: string | null): Promise<number> {
  const target = (name ?? INBOX_CATEGORY_NAME).trim()
  const categories = await getCategories()
  const existing = categories.find(c => c.name.trim().toLowerCase() === target.toLowerCase())
  if (existing) return existing.id
  return createCategory(target)
}

async function createChore(input: { name: string; categoryId: number }): Promise<{ id: number; sync_id: string }> {
  const id = await dbCreateChore({
    name: input.name,
    category_id: input.categoryId,
    target_cadence_days: null,
    notify_when_overdue: false,
    auto_schedule_to_dayglance: false,
    preferred_schedule_behavior: null,
    seasonal_start: null,
    seasonal_end: null,
    assigned_user_sync_ids: [],
  })
  const created = await db.chores.get(id)
  return { id, sync_id: created?.sync_id ?? '' }
}

async function getDoneToday(): Promise<number> {
  const events = await db.completionEvents.toArray()
  const today = dayjs().format('YYYY-MM-DD')
  return events.filter(e => dayjs(e.completed_at).format('YYYY-MM-DD') === today).length
}

// OPEN routing reuses the app's existing deep-link events (see
// native/pendingDeepLink.ts). 'app' just foregrounds — nothing to route.
function navigate(target: OpenTarget): void {
  switch (target) {
    case 'soon':
      window.dispatchEvent(new Event('lg:widget-filter-soon'))
      break
    case 'search':
      window.dispatchEvent(new Event('lg:open-search'))
      break
    case 'add':
      window.dispatchEvent(new Event('lg:new-chore'))
      break
    case 'app':
      break
  }
}

// Emits the outbound NOTIFY broadcast for a chore just completed via the Tasker
// COMPLETE action, so a local listener (Tasker, MacroDroid) can react. Plaintext
// only — a keyless local listener can't use anything else. Uses the shared
// NotifySchema field names so the payload is consistent with the file transport.
function onChoreCompleted(chore: { sync_id: string; name: string; completedAt: string }): void {
  const now = new Date()
  const payload = {
    schema_version: 1,
    event_id: eventId(now),
    emitted_at: now.toISOString(),
    emitted_by: SOURCE_APPS.LASTGLANCE,
    action: ACTIONS.NOTIFY,
    payload: {
      event_id: eventId(now),
      source_app: SOURCE_APPS.LASTGLANCE,
      source_entity_id: chore.sync_id,
      event: EVENTS.COMPLETED,
      task_id: chore.sync_id,
      title: chore.name,
      timestamp: chore.completedAt,
      completed_at: chore.completedAt,
    },
  }
  nativeSendNotifyBroadcast(JSON.stringify(payload))
}

// Builds the production IntentContext. `onChanged` refreshes derived UI (heatmap)
// after a mutating action, mirroring how the pollers call loadHeatmap.
export function buildIntentContext(onChanged?: () => void): IntentContext {
  return {
    listChores,
    ensureCategory,
    createChore: async (input) => {
      const created = await createChore(input)
      addActivityEntry({ type: 'received', message: `Created "${input.name}" via Tasker` })
      // Mirror the COMPLETE path and the poller transports: lg:chore-logged is
      // what makes the Ribbon reload its data. Without it, an intent-created
      // chore lands in the DB but stays invisible until the next app restart.
      window.dispatchEvent(new CustomEvent('lg:chore-logged'))
      onChanged?.()
      return created
    },
    getDoneToday,
    logCompletion: async (choreId, completedAt) => {
      await dbLogCompletion(choreId, { completedAt, completedByUserSyncId: getMeUserSyncId() })
      window.dispatchEvent(new CustomEvent('lg:chore-logged'))
      onChanged?.()
    },
    navigate,
    onChoreCompleted: (chore) => {
      addActivityEntry({ type: 'received', message: `Completed "${chore.name}" via Tasker` })
      onChoreCompleted(chore)
    },
  }
}
