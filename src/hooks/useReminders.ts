import { useEffect } from 'react'
import { Capacitor } from '@capacitor/core'
import { LocalNotifications } from '@capacitor/local-notifications'
import type { PluginListenerHandle } from '@capacitor/core'
import { syncReminders, handleNotificationAction } from '@/native/reminders'

// Keeps the native exact-alarm reminder set in sync with the chores, on the same
// signals as the widget snapshot, and routes notification taps to the chore.
// No-op off Android (syncReminders guards the platform internally).
export function useReminders(): void {
  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return

    syncReminders()

    const onChange = () => { syncReminders() }
    window.addEventListener('lg:chore-logged', onChange)
    window.addEventListener('lg:sync-applied', onChange)

    const onVisibility = () => {
      if (document.visibilityState === 'visible') syncReminders()
    }
    document.addEventListener('visibilitychange', onVisibility)

    let tapHandle: PluginListenerHandle | undefined
    LocalNotifications.addListener('localNotificationActionPerformed', action => {
      handleNotificationAction(action.actionId, action.notification.extra)
    }).then(handle => { tapHandle = handle })

    return () => {
      window.removeEventListener('lg:chore-logged', onChange)
      window.removeEventListener('lg:sync-applied', onChange)
      document.removeEventListener('visibilitychange', onVisibility)
      tapHandle?.remove()
    }
  }, [])
}
