import { useCallback, useEffect, useState } from 'react'
import { desktopBridge, type DesktopBackgroundSettings } from '@/native/desktop'

// The desktop app's background settings (docs/desktop-app.md, section 7), kept
// by the main process in userData. Null until read, and always off the desktop.
export function useDesktopBackgroundSettings(): {
  settings: DesktopBackgroundSettings | null
  update: (patch: Partial<DesktopBackgroundSettings>) => void
} {
  const [settings, setSettings] = useState<DesktopBackgroundSettings | null>(null)

  useEffect(() => {
    const bridge = desktopBridge()
    if (!bridge) return
    let live = true
    bridge.shell.getBackgroundSettings().then((s) => { if (live) setSettings(s) }).catch(() => {})
    return () => { live = false }
  }, [])

  const update = useCallback((patch: Partial<DesktopBackgroundSettings>) => {
    const bridge = desktopBridge()
    if (!bridge) return
    // Optimistic, then whatever main applied (open at login can be refused).
    setSettings((s) => (s ? { ...s, ...patch } : s))
    bridge.shell.setBackgroundSettings(patch).then(setSettings).catch(() => {})
  }, [])

  return { settings, update }
}
