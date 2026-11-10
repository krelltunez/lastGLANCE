import { useEffect } from 'react'
import { routeWidgetDeepLink } from '@/native/pendingDeepLink'
import { isNativeShell } from '@/native/platform'
import { desktopBridge } from '@/native/desktop'

// Consume a widget body-tap / shortcut deep link on mount and on each return to
// foreground. Runs in both native shells — MainActivity and the iOS AppDelegate
// stash the identical token forms — and no-ops on web/PWA.
//
// The desktop app stashes the same tokens (lastglance:// links, reminder
// clicks, the tray) and says when one is waiting.
export function usePendingDeepLink(): void {
  useEffect(() => {
    const desktop = desktopBridge()
    if (!isNativeShell() && !desktop) return

    routeWidgetDeepLink()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') routeWidgetDeepLink()
    }
    document.addEventListener('visibilitychange', onVisibility)
    const offDesktop = desktop?.widget.onDeepLink(() => { void routeWidgetDeepLink() })
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      offDesktop?.()
    }
  }, [])
}
