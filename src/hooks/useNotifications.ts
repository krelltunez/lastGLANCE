import { useEffect, useRef } from 'react'
import { getCategories, getChoresForCategory, logCompletion } from '@/db/queries'
import { useToast, type ToastOptions } from '@/components/Toast/Toast'
import { useIntents } from '@/intents/IntentsContext'
import { emitCreateIntent } from '@/intents/emitter'
import { getMultiUserEnabled, getMeUserSyncId } from '@/multiuser/settings'
import { ownedByMe } from '@/utils/choreFilter'
import dayjs from 'dayjs'

const STORAGE_KEY = (choreId: number) => `lg_notified_${choreId}`
const AUTO_SCHED_KEY = (choreId: number) => `lg_autosched_${choreId}`

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
  if (!('Notification' in window)) return 'denied'
  if (Notification.permission === 'granted') return 'granted'
  return Notification.requestPermission()
}

export function useNotifications() {
  const { showToast } = useToast()
  // Ref so the async checkAndNotify closure always sees the latest showToast
  const showToastRef = useRef<(opts: ToastOptions) => void>(showToast)
  useEffect(() => { showToastRef.current = showToast }, [showToast])

  const { isConfigured } = useIntents()
  const isConfiguredRef = useRef<boolean>(isConfigured)
  useEffect(() => { isConfiguredRef.current = isConfigured }, [isConfigured])

  useEffect(() => {
    async function checkAndNotify() {
      const today = dayjs().format('YYYY-MM-DD')
      const categories = await getCategories()
      const allChores = (await Promise.all(categories.map(c => getChoresForCategory(c.id)))).flat()

      // In multi-user mode, only act on chores owned by "Me" — shared
      // (unassigned) or assigned to me, and not inside a category assigned to
      // someone else. Mirrors the "Mine" view filter (filterCategoryData) so we
      // don't surface (or auto-schedule) another user's chores.
      const meId = getMeUserSyncId()
      const filterByMe = getMultiUserEnabled() && !!meId
      const categoryById = new Map(categories.map(c => [c.id, c]))

      for (const chore of allChores) {
        if (filterByMe) {
          const category = categoryById.get(chore.category_id)
          if (!ownedByMe(category?.assigned_user_sync_ids ?? [], meId!) ||
              !ownedByMe(chore.assigned_user_sync_ids ?? [], meId!)) {
            continue
          }
        }

        const isOverdue = chore.notify_when_overdue &&
          chore.target_cadence_days &&
          chore.elapsed_days !== null &&
          chore.elapsed_days >= chore.target_cadence_days

        if (isOverdue) {
          if (localStorage.getItem(STORAGE_KEY(chore.id!)) !== today) {
            const overdue = Math.floor(chore.elapsed_days! - chore.target_cadence_days!)
            const body = overdue > 0
              ? `${overdue} day${overdue > 1 ? 's' : ''} overdue`
              : 'Due today'

            if (document.visibilityState === 'visible') {
              const choreId = chore.id!
              const toastOpts: ToastOptions = {
                title: chore.name,
                body,
                type: 'warning',
                onAction: async () => {
                  await logCompletion(choreId)
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
            } else {
              await fireBrowserNotification(chore.name, body)
            }

            localStorage.setItem(STORAGE_KEY(chore.id!), today)
          }
        }

        // Auto-schedule: emit at most once per day when overdue
        if (
          chore.auto_schedule_to_dayglance &&
          isConfiguredRef.current &&
          chore.target_cadence_days &&
          chore.elapsed_days !== null &&
          chore.elapsed_days >= chore.target_cadence_days
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

    checkAndNotify()
    const interval = setInterval(checkAndNotify, 60 * 60 * 1000)
    function onVisibilityChange() { if (document.visibilityState === 'visible') checkAndNotify() }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])
}
