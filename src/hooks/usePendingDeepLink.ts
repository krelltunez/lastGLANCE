import { useEffect } from 'react'
import { Capacitor } from '@capacitor/core'
import { routeWidgetDeepLink } from '@/native/pendingDeepLink'

// Consume a widget body-tap deep link on mount and on each return to foreground.
// No-op off Android.
export function usePendingDeepLink(): void {
  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return

    routeWidgetDeepLink()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') routeWidgetDeepLink()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])
}
