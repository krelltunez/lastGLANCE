import { useEffect } from 'react'
import { Capacitor } from '@capacitor/core'
import { drainWidgetCompletions } from '@/native/pendingCompletions'

// Drains widget-originated completions into the DB on mount and whenever the app
// returns to the foreground (when a widget tap may have queued one while we were
// away). No-op off Android.
export function usePendingCompletions(): void {
  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return

    drainWidgetCompletions()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') drainWidgetCompletions()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])
}
