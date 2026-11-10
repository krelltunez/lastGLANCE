import { useEffect } from 'react'
import { pushSnapshot } from '@/native/snapshot'
import { PEOPLE_CHANGED_EVENT } from '@/people/queries'
import i18n from 'i18next'
import { WEEK_START_CHANGED_EVENT } from '@/utils/datetime'
import { desktopBridge } from '@/native/desktop'

const DESKTOP_REFRESH_MS = 15 * 60 * 1000

// Keeps the native widget snapshot fresh. Pushes on mount, whenever a chore is
// logged, People change or a sync is applied (the signals the in-app heatmap
// listens to), and when the app is being backgrounded so the launcher sees
// current data.
// No-op on web/PWA (pushSnapshot guards the platform internally); runs in both
// native shells.
export function useWidgetSnapshot(): void {
  useEffect(() => {
    pushSnapshot()

    const onChange = () => { pushSnapshot() }
    window.addEventListener('lg:chore-logged', onChange)
    window.addEventListener('lg:sync-applied', onChange)
    // People writes come in bursts (a contacts import adds a row at a time).
    let peopleTimer: ReturnType<typeof setTimeout> | undefined
    const onPeople = () => {
      clearTimeout(peopleTimer)
      peopleTimer = setTimeout(onChange, 500)
    }
    window.addEventListener(PEOPLE_CHANGED_EVENT, onPeople)
    // The People block carries text in the app's language.
    i18n.on('languageChanged', onChange)
    // The heatmap widgets draw their grid from the snapshot's week start.
    window.addEventListener(WEEK_START_CHANGED_EVENT, onChange)

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') pushSnapshot()
    }
    // The desktop tray shows each chore's state as of the last snapshot; a
    // chore turns due with no event, so the desktop re-pushes on a timer.
    const refresh = desktopBridge() ? setInterval(onChange, DESKTOP_REFRESH_MS) : undefined
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.removeEventListener('lg:chore-logged', onChange)
      window.removeEventListener('lg:sync-applied', onChange)
      window.removeEventListener(PEOPLE_CHANGED_EVENT, onPeople)
      i18n.off('languageChanged', onChange)
      window.removeEventListener(WEEK_START_CHANGED_EVENT, onChange)
      clearTimeout(peopleTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      clearInterval(refresh)
    }
  }, [])
}
