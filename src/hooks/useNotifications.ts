import { useEffect } from 'react'
import { getCategories, getChoresForCategory } from '@/db/queries'
import dayjs from 'dayjs'

const STORAGE_KEY = (choreId: number) => `lg_notified_${choreId}`

async function fireNotification(title: string, body: string) {
  if (Notification.permission !== 'granted') return
  const icon = '/icons/icon-192.png'
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready
      await reg.showNotification(title, { body, icon, badge: icon })
      return
    } catch {
      // fall through to Notification API
    }
  }
  new Notification(title, { body, icon })
}

async function checkAndNotify() {
  if (Notification.permission !== 'granted') return
  const today = dayjs().format('YYYY-MM-DD')
  const categories = await getCategories()
  const allChores = (await Promise.all(categories.map(c => getChoresForCategory(c.id)))).flat()

  for (const chore of allChores) {
    if (!chore.notify_when_overdue) continue
    if (!chore.target_cadence_days) continue
    if (chore.elapsed_days === null || chore.elapsed_days <= chore.target_cadence_days) continue
    if (localStorage.getItem(STORAGE_KEY(chore.id!)) === today) continue

    const overdue = Math.floor(chore.elapsed_days - chore.target_cadence_days)
    const body = overdue > 0
      ? `${overdue} day${overdue > 1 ? 's' : ''} overdue`
      : 'Due today'
    await fireNotification(chore.name, body)
    localStorage.setItem(STORAGE_KEY(chore.id!), today)
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied'
  if (Notification.permission === 'granted') return 'granted'
  return Notification.requestPermission()
}

export function useNotifications() {
  useEffect(() => {
    if (!('Notification' in window)) return
    checkAndNotify()

    function onFocus() { checkAndNotify() }
    document.addEventListener('visibilitychange', onFocus)
    return () => document.removeEventListener('visibilitychange', onFocus)
  }, [])
}
