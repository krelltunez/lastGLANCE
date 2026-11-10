import { useEffect, useRef } from 'react'
import { buildIntentContext } from '@/intents/intentContext'
import { desktopBridge } from '@/native/desktop'
import { drainDesktopCommands } from '@/native/desktopCommands'

// Drains the desktop command queue (src/native/desktopCommands.ts) on mount,
// when main says a command was queued, and on the foreground and wake kicks.
// No-op off the desktop. `onChanged` refreshes derived UI (the heatmap).
export function useDesktopCommands(onChanged?: () => void): void {
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged

  useEffect(() => {
    const bridge = desktopBridge()
    if (!bridge) return
    let cancelled = false
    let draining = false
    let rerun = false
    const drain = async (): Promise<void> => {
      if (draining) { rerun = true; return }
      draining = true
      try {
        do {
          rerun = false
          await drainDesktopCommands(bridge.commands, (via) => buildIntentContext(() => onChangedRef.current?.(), via), () => cancelled)
        } while (rerun && !cancelled)
      } finally {
        draining = false
      }
    }
    void drain()
    const off = bridge.commands.onQueued(() => { void drain() })
    const onVisibility = () => { void drain() }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      off()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
}
