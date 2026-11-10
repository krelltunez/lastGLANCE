import { useEffect, useRef } from 'react'
import i18n from 'i18next'
import { getCategories, getChoresForCategory, logCompletion } from '@/db/queries'
import { hasNativeReminders } from '@/native/platform'
import { reminderNotifications } from '@/native/reminders'
import { useToast, type ToastOptions } from '@/components/Toast/Toast'
import { useIntents } from '@/intents/IntentsContext'
import { emitCreateIntent } from '@/intents/emitter'
import { getMultiUserEnabled, getMeUserSyncId } from '@/multiuser/settings'
import { ownedByMe } from '@/utils/choreFilter'
import { isPastCadence } from '@/utils/cadence'
import type { ChoreWithLastCompletion } from '@/types'
import dayjs from 'dayjs'

const STORAGE_KEY = (choreId: number) => `lg_notified_${choreId}`
const AUTO_SCHED_KEY = (choreId: number) => `lg_autosched_${choreId}`

// The overdue checks read the LOCAL DB, which on launch/foreground predates the
// sync and intents deliveries kicked off at the same moment — a chore completed
// on another device (or in dayGLANCE) still reads as overdue for a few seconds.
// Two mitigations, matched to what each mistake costs:
//
//  - The toast is retractable, so it fires immediately and a reconciler
//    dismisses it if an arriving completion makes it stale (see the second
//    effect below). Applies from any lg:chore-logged/lg:sync-applied source:
//    both sync tiers, both intents pollers, and local completions.
//  - The dayGLANCE auto-schedule emit is durable and CANNOT be recalled, so it
//    instead waits out a grace period and re-reads fresh rows before deciding.
//    A settle signal would be nicer than a delay, but "sync is done" has no
//    single definition here — completions arrive via the file tier, the vault
//    tier, or either intents poller, each optional, and (since sync 1.10.0) a
//    cycle may legitimately be suppressed by backoff — so the honest gate is a
//    delay that comfortably covers a normal launch sync, then the freshest
//    data available. Nothing user-visible waits on it, and the once-per-day
//    marker means the delay is imperceptible.
const RECONCILE_DEBOUNCE_MS = 400
const AUTO_SCHED_SYNC_GRACE_MS = 15_000

// Chores the current user acts on: everything, or in multi-user mode only
// chores owned by "Me" — shared (unassigned) or assigned to me, and not inside
// a category assigned to someone else. Mirrors the "Mine" view filter
// (filterCategoryData) so we don't surface (or auto-schedule) another user's
// chores.
async function candidateChores(): Promise<ChoreWithLastCompletion[]> {
  const categories = await getCategories()
  const allChores = (await Promise.all(categories.map(c => getChoresForCategory(c.id)))).flat()
  const meId = getMeUserSyncId()
  if (!getMultiUserEnabled() || !meId) return allChores
  const categoryById = new Map(categories.map(c => [c.id, c]))
  return allChores.filter(chore => {
    const category = categoryById.get(chore.category_id)
    return ownedByMe(category?.assigned_user_sync_ids ?? [], meId) &&
      ownedByMe(chore.assigned_user_sync_ids ?? [], meId)
  })
}

async function fireBrowserNotification(title: string, body: string) {
  if (Notification.permission !== 'granted') return
  const icon = '/icons/icon-192.png'
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready
      await reg.showNotification(title, { body, icon, badge: icon })
      return
    } catch {
      // fall through
    }
  }
  new Notification(title, { body, icon })
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  // In both native shells the WebView's Notification API is unavailable (absent
  // in WKWebView, unusable in Android's WebView), and the real permission lives
  // in the native Local Notifications plugin, which also delivers the closed-app
  // reminders. Check/request there and map the plugin's PermissionState onto the
  // web NotificationPermission the UI expects.
  if (hasNativeReminders()) {
    try {
      const notifications = reminderNotifications()
      let status = await notifications.checkPermissions()
      if (status.display === 'prompt' || status.display === 'prompt-with-rationale') {
        status = await notifications.requestPermissions()
      }
      if (status.display === 'granted') return 'granted'
      return status.display === 'denied' ? 'denied' : 'default'
    } catch {
      return 'denied'
    }
  }
  if (!('Notification' in window)) return 'denied'
  if (Notification.permission === 'granted') return 'granted'
  return Notification.requestPermission()
}

export function useNotifications() {
  const { showToast, dismissWhere } = useToast()
  // Ref so the async checkAndNotify closure always sees the latest showToast
  const showToastRef = useRef<(opts: ToastOptions) => void>(showToast)
  useEffect(() => { showToastRef.current = showToast }, [showToast])

  const { isConfigured } = useIntents()
  const isConfiguredRef = useRef<boolean>(isConfigured)
  useEffect(() => { isConfiguredRef.current = isConfigured }, [isConfigured])

  useEffect(() => {
    // Trailing-edge: each trigger restarts the grace window, and the evaluation
    // re-reads the DB after it, so it always runs on the freshest rows.
    let autoSchedTimer: ReturnType<typeof setTimeout> | null = null

    async function runAutoSchedule() {
      const today = dayjs().format('YYYY-MM-DD')
      for (const chore of await candidateChores()) {
        // Auto-schedule: emit at most once per day when overdue
        if (
          chore.auto_schedule_to_dayglance &&
          isConfiguredRef.current &&
          isPastCadence(chore.target_cadence_days, chore.elapsed_days)
        ) {
          if (localStorage.getItem(AUTO_SCHED_KEY(chore.id!)) !== today) {
            // Write the "sent today" marker ONLY after a durable enqueue. The old
            // order wrote it BEFORE the send, so a failed send was both lost and
            // suppressed for the rest of the day. Enqueue is durable, so once it
            // resolves the intent will be delivered (retried as needed); a failed
            // enqueue leaves the marker unset so the next pass retries.
            const queued = await emitCreateIntent(chore).catch(() => false)
            if (queued) localStorage.setItem(AUTO_SCHED_KEY(chore.id!), today)
          }
        }
      }
    }

    async function checkAndNotify() {
      const today = dayjs().format('YYYY-MM-DD')

      for (const chore of await candidateChores()) {
        const isOverdue = chore.notify_when_overdue &&
          isPastCadence(chore.target_cadence_days, chore.elapsed_days)

        if (isOverdue) {
          if (localStorage.getItem(STORAGE_KEY(chore.id!)) !== today) {
            const overdue = Math.floor(chore.elapsed_days! - chore.target_cadence_days!)
            const body = overdue > 0
              ? i18n.t('notifications.daysOverdue', { count: overdue })
              : i18n.t('notifications.dueToday')

            if (document.visibilityState === 'visible') {
              const choreId = chore.id!
              const toastOpts: ToastOptions = {
                title: chore.name,
                body,
                type: 'warning',
                // Lets the reconciler retract this toast if a completion for
                // the chore lands after the fact (synced from another device,
                // or made in dayGLANCE).
                choreId,
                onAction: async () => {
                  await logCompletion(choreId, { completedByUserSyncId: getMeUserSyncId() })
                  window.dispatchEvent(new CustomEvent('lg:chore-logged'))
                },
                onDetails: () => {
                  window.dispatchEvent(new CustomEvent('lg:open-chore', { detail: { choreId } }))
                },
              }
              if (isConfiguredRef.current) {
                toastOpts.onSendToDayGlance = async () => emitCreateIntent(chore)
              }
              showToastRef.current(toastOpts)
            } else if (!hasNativeReminders()) {
              // In both native shells and the desktop app the scheduled
              // reminders (useReminders) own closed/backgrounded delivery — skip
              // the web notification so it isn't duplicated. Web/PWA keeps the
              // in-WebView path.
              await fireBrowserNotification(chore.name, body)
            }

            localStorage.setItem(STORAGE_KEY(chore.id!), today)
          }
        }
      }

      // The irreversible half runs after the sync grace, on a fresh read (see
      // the constants above for why this is a delay and not a settle signal).
      if (autoSchedTimer) clearTimeout(autoSchedTimer)
      autoSchedTimer = setTimeout(() => {
        autoSchedTimer = null
        runAutoSchedule().catch(() => {/* next trigger retries */})
      }, AUTO_SCHED_SYNC_GRACE_MS)
    }

    checkAndNotify()
    const interval = setInterval(checkAndNotify, 60 * 60 * 1000)
    function onVisibilityChange() { if (document.visibilityState === 'visible') checkAndNotify() }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (autoSchedTimer) clearTimeout(autoSchedTimer)
    }
  }, [])

  // Reconcile visible overdue toasts against reality whenever a completion
  // lands. Every path that writes a completion into Dexie dispatches
  // lg:chore-logged (both sync tiers, both intents pollers, the native pending
  // path, and local logging), so this is the complete "data changed" signal.
  // The vault tier fires per applied row, so a pull produces a burst — debounce
  // and re-check once. A chore that vanished entirely (remote delete) also
  // leaves the overdue set, which retracts its toast too.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null

    async function reconcile() {
      const categories = await getCategories()
      const chores = (await Promise.all(categories.map(c => getChoresForCategory(c.id)))).flat()
      const stillOverdue = new Set(
        chores
          .filter(c => isPastCadence(c.target_cadence_days, c.elapsed_days))
          .map(c => c.id!),
      )
      dismissWhere(t => t.choreId != null && !stillOverdue.has(t.choreId))
    }

    function scheduleReconcile() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        reconcile().catch(() => {/* transient read failure; next event retries */})
      }, RECONCILE_DEBOUNCE_MS)
    }

    window.addEventListener('lg:chore-logged', scheduleReconcile)
    window.addEventListener('lg:sync-applied', scheduleReconcile)
    return () => {
      window.removeEventListener('lg:chore-logged', scheduleReconcile)
      window.removeEventListener('lg:sync-applied', scheduleReconcile)
      if (timer) clearTimeout(timer)
    }
  }, [dismissWhere])
}
