import { useEffect } from 'react'
import { LocalNotifications } from '@capacitor/local-notifications'
import type { PluginListenerHandle } from '@capacitor/core'
import i18n from 'i18next'
import { syncReminders, handleNotificationAction } from '@/native/reminders'
import { hasNativeReminders, isNativeShell } from '@/native/platform'
import { PEOPLE_CHANGED_EVENT } from '@/people/queries'
import { DATE_REMINDER_TIME_KEY, DATE_REMINDERS_KEY, DIGEST_TIME_KEY } from '@/people/settings'

// The People reminder settings: dates on/off and the two times.
const SETTING_EVENTS = [DATE_REMINDERS_KEY, DATE_REMINDER_TIME_KEY, DIGEST_TIME_KEY].map(k => `lg:setting:${k}`)

// Keeps the native reminder set in sync with the chores and People, on the same
// signals as the widget snapshot, and routes notification taps to the chore or
// person. Runs in both
// native shells; no-op on web/PWA (syncReminders also guards internally).
export function useReminders(): void {
  useEffect(() => {
    if (!hasNativeReminders()) return

    syncReminders()

    const onChange = () => { syncReminders() }
    window.addEventListener('lg:chore-logged', onChange)
    window.addEventListener('lg:sync-applied', onChange)
    for (const name of SETTING_EVENTS) window.addEventListener(name, onChange)
    // People writes come in bursts (a contacts import adds a row at a time),
    // so they settle before one resync.
    let peopleTimer: ReturnType<typeof setTimeout> | undefined
    const onPeople = () => {
      clearTimeout(peopleTimer)
      peopleTimer = setTimeout(onChange, 500)
    }
    window.addEventListener(PEOPLE_CHANGED_EVENT, onPeople)
    // Notification text is baked at schedule time, so a language switch must
    // re-run the sync: the body diff in syncReminders then re-bakes every
    // pending reminder (and the channel/action labels re-register) in the new
    // language.
    i18n.on('languageChanged', onChange)

    const onVisibility = () => {
      if (document.visibilityState === 'visible') syncReminders()
    }
    document.addEventListener('visibilitychange', onVisibility)

    // The phones route a tap here; the desktop app's main process opens the
    // target or queues the action itself (src/native/desktopNotifications.ts).
    let tapHandle: PluginListenerHandle | undefined
    if (isNativeShell()) {
      LocalNotifications.addListener('localNotificationActionPerformed', action => {
        handleNotificationAction(action.actionId, action.notification.extra)
      }).then(handle => { tapHandle = handle })
    }

    return () => {
      window.removeEventListener('lg:chore-logged', onChange)
      window.removeEventListener('lg:sync-applied', onChange)
      for (const name of SETTING_EVENTS) window.removeEventListener(name, onChange)
      window.removeEventListener(PEOPLE_CHANGED_EVENT, onPeople)
      clearTimeout(peopleTimer)
      i18n.off('languageChanged', onChange)
      document.removeEventListener('visibilitychange', onVisibility)
      tapHandle?.remove()
    }
  }, [])
}
