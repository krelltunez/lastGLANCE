import { useEffect, useRef } from 'react'
import { getCategories, getChoresForCategory, logCompletion } from '@/db/queries'
import { useToast, type ToastOptions } from '@/components/Toast/Toast'
import dayjs from 'dayjs'

const STORAGE_KEY = (choreId: number) => `lg_notified_${choreId}`

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

  useEffect(() => {
    async function checkAndNotify() {
      const today = dayjs().format('YYYY-MM-DD')
      const categories = await getCategories()
      const allChores = (await Promise.all(categories.map(c => getChoresForCategory(c.id)))).flat()

      for (const chore of allChores) {
        if (!chore.notify_when_overdue) continue
        if (!chore.target_cadence_days) continue
        if (chore.elapsed_days === null || chore.elapsed_days < chore.target_cadence_days) continue
        if (localStorage.getItem(STORAGE_KEY(chore.id!)) === today) continue

        const overdue = Math.floor(chore.elapsed_days - chore.target_cadence_days)
        const body = overdue > 0
          ? `${overdue} day${overdue > 1 ? 's' : ''} overdue`
          : 'Due today'

        if (document.visibilityState === 'visible') {
          const choreId = chore.id!
          showToastRef.current({
            title: chore.name,
            body,
            type: 'warning',
            onAction: async () => {
              await logCompletion(choreId)
              window.dispatchEvent(new CustomEvent('lg:chore-logged'))
            },
          })
        } else {
          await fireBrowserNotification(chore.name, body)
        }

        localStorage.setItem(STORAGE_KEY(chore.id!), today)
      }
    }

    checkAndNotify()
    const interval = setInterval(checkAndNotify, 60 * 60 * 1000)
    function onVisibilityChange() { checkAndNotify() }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])
}
