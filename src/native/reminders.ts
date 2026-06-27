import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import type { PendingLocalNotificationSchema } from '@capacitor/local-notifications'
import { getCategories, getChoresForCategory, logCompletion } from '@/db/queries'
import { db } from '@/db/client'
import { setPendingOpenChore } from './pendingOpenChore'
import { emitCreateIntent } from '@/intents/emitter'
import { getIntentsConfig, isIntentsConfigured } from '@/intents/config'
import { ownedByMe } from '@/utils/choreFilter'
import { isInSeasonalWindow } from '@/utils/seasonal'
import { getMeUserSyncId } from '@/multiuser/settings'
import type { ChoreWithLastCompletion } from '@/types'
import dayjs from 'dayjs'

// Phase 1: closed-app overdue notifications. The web app pre-computes each
// chore's next-overdue instant (last completion + cadence) and registers it as
// an exact Android alarm via @capacitor/local-notifications, so notifications
// fire when the app is closed — replacing the in-WebView timer that only ran
// while the app was alive. Native owns closed-app delivery; the in-app toast in
// useNotifications.ts still covers the foreground case.
//
// No-op anywhere but Android (the only platform wired so far).

const CHANNEL_ID = 'overdue'
const EXACT_PROMPTED_KEY = 'lg_exact_alarm_prompted'

// Two action sets: "Mark done" alone, or with "Send to dayGLANCE" when cross-app
// intents are configured. The choice is baked into each notification at schedule
// time via actionTypeId, and refreshes whenever syncReminders re-runs.
const ACTION_TYPE = 'OVERDUE'
const ACTION_TYPE_DG = 'OVERDUE_DG'

interface ReminderDescriptor {
  id: number // stable numeric id derived from choreSyncId
  choreSyncId: string
  title: string
  body: string
  triggerAtMillis: number
  dgEnabled: boolean // include the "Send to dayGLANCE" action button
}

// Deterministic positive 31-bit id from a chore's sync_id (UUID). Notification
// ids must be Java ints; mapping a chore to a stable id means re-scheduling
// replaces its alarm in place rather than stacking a duplicate.
export function reminderIdFor(syncId: string): number {
  let h = 0
  for (let i = 0; i < syncId.length; i++) {
    h = (Math.imul(31, h) + syncId.charCodeAt(i)) | 0
  }
  return (h & 0x7fffffff) || 1
}

let actionTypesReady = false
async function ensureActionTypes(): Promise<void> {
  if (actionTypesReady) return
  try {
    await LocalNotifications.registerActionTypes({
      types: [
        { id: ACTION_TYPE, actions: [{ id: 'mark_done', title: 'Mark done' }] },
        {
          id: ACTION_TYPE_DG,
          actions: [
            { id: 'mark_done', title: 'Mark done' },
            { id: 'send_dg', title: 'Send to dayGLANCE' },
          ],
        },
      ],
    })
    actionTypesReady = true
  } catch {
    // Best-effort; notifications still fire without action buttons.
  }
}

let channelReady = false
async function ensureChannel(): Promise<void> {
  if (channelReady) return
  try {
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: 'Overdue chores',
      description: 'Reminds you when a chore passes its cadence.',
      importance: 4, // HIGH — heads-up
      visibility: 1, // public
    })
    channelReady = true
  } catch {
    // Channel creation is best-effort; scheduling still works on the default.
  }
}

// On Android 12+ exact alarms require the user to grant "Alarms & reminders".
// Without it the plugin silently falls back to inexact (Doze-batched) delivery —
// the classic "late when closed" failure. Prompt once, lazily, and only when we
// actually have something to schedule, so users who never opt a chore into
// reminders are never sent to Settings.
async function maybePromptExactAlarm(): Promise<void> {
  if (localStorage.getItem(EXACT_PROMPTED_KEY)) return
  try {
    const status = await LocalNotifications.checkExactNotificationSetting()
    // Mark prompted up front so we never re-open Settings on subsequent syncs.
    localStorage.setItem(EXACT_PROMPTED_KEY, '1')
    if (status.exact_alarm !== 'granted') {
      await LocalNotifications.changeExactNotificationSetting()
    }
  } catch {
    // Method unavailable (older plugin/OS) — allowWhileIdle still gives
    // best-effort delivery.
  }
}

async function buildReminders(dgEnabled: boolean): Promise<ReminderDescriptor[]> {
  const meId = getMeUserSyncId()
  const categories = await getCategories()
  const lists = await Promise.all(categories.map(c => getChoresForCategory(c.id)))
  const now = Date.now()
  const out: ReminderDescriptor[] = []

  for (const list of lists) {
    for (const ch of list) {
      // Eligibility — mirrors the in-app overdue check (see plan §2).
      if (!ch.notify_when_overdue) continue
      if (ch.target_cadence_days == null) continue
      if (ch.last_completed_at == null) continue
      if (!isInSeasonalWindow(ch)) continue
      if (meId && !ownedByMe(ch.assigned_user_sync_ids ?? [], meId)) continue

      const triggerAtMillis = dayjs(ch.last_completed_at)
        .add(ch.target_cadence_days, 'day')
        .valueOf()
      // Already overdue → the in-app toast surfaces it; we only pre-schedule
      // future crossings (a past `at` would fire immediately on every sync).
      if (triggerAtMillis <= now) continue

      const days = ch.target_cadence_days
      out.push({
        id: reminderIdFor(ch.sync_id),
        choreSyncId: ch.sync_id,
        title: ch.name,
        body: `It's been ${days} ${days === 1 ? 'day' : 'days'}`,
        triggerAtMillis,
        dgEnabled,
      })
    }
  }
  return out
}

// Diff-replace the scheduled alarm set: cancel only what's removed or changed,
// schedule only what's new or changed. Avoids a blanket cancel-all that could
// drop an alarm in the window before it's re-registered.
export async function syncReminders(): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return
  try {
    let perm = await LocalNotifications.checkPermissions()
    if (perm.display !== 'granted') {
      perm = await LocalNotifications.requestPermissions()
      if (perm.display !== 'granted') return
    }
    await ensureChannel()
    await ensureActionTypes()

    const dgEnabled = isIntentsConfigured(getIntentsConfig())
    const desired = await buildReminders(dgEnabled)
    if (desired.length > 0) await maybePromptExactAlarm()

    const desiredById = new Map(desired.map(r => [r.id, r]))
    const pending: PendingLocalNotificationSchema[] =
      (await LocalNotifications.getPending()).notifications
    const pendingById = new Map(pending.map(p => [p.id, p]))

    const changed = (p: PendingLocalNotificationSchema, d: ReminderDescriptor) => {
      const extra = (p.extra ?? {}) as { triggerAtMillis?: number; dg?: boolean }
      return (
        extra.triggerAtMillis !== d.triggerAtMillis ||
        p.body !== d.body ||
        (extra.dg ?? false) !== d.dgEnabled
      )
    }

    const toCancel = pending.filter(p => {
      const d = desiredById.get(p.id)
      return !d || changed(p, d)
    })
    if (toCancel.length > 0) {
      await LocalNotifications.cancel({ notifications: toCancel.map(p => ({ id: p.id })) })
    }

    const cancelledIds = new Set(toCancel.map(p => p.id))
    const toSchedule = desired.filter(d => !pendingById.has(d.id) || cancelledIds.has(d.id))
    if (toSchedule.length > 0) {
      await LocalNotifications.schedule({
        notifications: toSchedule.map(d => ({
          id: d.id,
          title: d.title,
          body: d.body,
          channelId: CHANNEL_ID,
          actionTypeId: d.dgEnabled ? ACTION_TYPE_DG : ACTION_TYPE,
          schedule: { at: new Date(d.triggerAtMillis), allowWhileIdle: true },
          extra: {
            choreSyncId: d.choreSyncId,
            deepLink: `lastglance://chore/${d.choreSyncId}`,
            triggerAtMillis: d.triggerAtMillis,
            dg: d.dgEnabled,
          },
        })),
      })
    }
  } catch {
    // Best-effort: reminders must never disrupt the app.
  }
}

async function markChoreDone(choreSyncId: string): Promise<void> {
  const chore = await db.chores.where('sync_id').equals(choreSyncId).first()
  if (chore?.id == null) return
  await logCompletion(chore.id)
  // Refreshes the list/heatmap, repushes the widget snapshot, and re-runs
  // syncReminders — which reschedules this chore's next overdue alarm.
  window.dispatchEvent(new CustomEvent('lg:chore-logged'))
}

async function sendChoreToDayGlance(choreSyncId: string): Promise<void> {
  const chore = await db.chores.where('sync_id').equals(choreSyncId).first()
  if (!chore) return
  // emitCreateIntent re-checks configuration internally and no-ops if intents
  // aren't set up. It only reads name/sync_id/assignees, so the missing
  // last/elapsed fields are irrelevant here.
  await emitCreateIntent({ ...chore, last_completed_at: null, elapsed_days: null } as ChoreWithLastCompletion)
}

// Routes a notification interaction. The plugin opens the app for every action
// (no background actions in the official plugin), then replays this — retained
// across a cold start, so it survives a killed app. 'tap' is the body press;
// 'mark_done' / 'send_dg' are the action buttons.
export function handleNotificationAction(actionId: string, extra: unknown): void {
  const choreSyncId = (extra as { choreSyncId?: string } | null)?.choreSyncId
  if (!choreSyncId) return
  if (actionId === 'mark_done') {
    void markChoreDone(choreSyncId)
    return
  }
  if (actionId === 'send_dg') {
    void sendChoreToDayGlance(choreSyncId)
    return
  }
  // Body tap (actionId 'tap') or anything else → focus the chore. Recorded as a
  // durable pending request the Ribbon consumes once its data has loaded, so the
  // cold-start ordering between the tap and the first data load doesn't matter.
  setPendingOpenChore(choreSyncId)
  window.dispatchEvent(new Event('lg:open-chore-pending'))
}
