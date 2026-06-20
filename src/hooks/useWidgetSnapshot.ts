import { useEffect } from 'react'
import { pushSnapshot } from '@/native/snapshot'

// Keeps the native widget snapshot fresh. Pushes on mount, whenever a chore is
// logged or a sync is applied (the same signals the in-app heatmap listens to),
// and when the app is being backgrounded so the launcher sees current data.
// No-op off Android (pushSnapshot guards the platform internally).
export function useWidgetSnapshot(): void {
  useEffect(() => {
    pushSnapshot()

    const onChange = () => { pushSnapshot() }
    window.addEventListener('lg:chore-logged', onChange)
    window.addEventListener('lg:sync-applied', onChange)

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') pushSnapshot()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.removeEventListener('lg:chore-logged', onChange)
      window.removeEventListener('lg:sync-applied', onChange)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
}
