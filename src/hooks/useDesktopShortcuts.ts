import { useCallback, useEffect, useState } from 'react'
import { desktopBridge, type DesktopShortcuts } from '@/native/desktop'

// The desktop app's global shortcuts (Settings, Desktop app), kept and
// registered by the main process. Null until read, and always off the desktop.
// `failed` names the shortcut main could not register: another app holds it.
export function useDesktopShortcuts(): {
  shortcuts: DesktopShortcuts | null
  failed: 'popup' | 'window' | null
  set: (kind: 'popup' | 'window', accelerator: string) => void
} {
  const [shortcuts, setShortcuts] = useState<DesktopShortcuts | null>(null)
  const [failed, setFailed] = useState<'popup' | 'window' | null>(null)

  useEffect(() => {
    const bridge = desktopBridge()
    if (!bridge) return
    let live = true
    bridge.shell.getShortcuts().then((s) => { if (live) setShortcuts(s) }).catch(() => {})
    return () => { live = false }
  }, [])

  const set = useCallback((kind: 'popup' | 'window', accelerator: string) => {
    const bridge = desktopBridge()
    if (!bridge) return
    bridge.shell.setShortcut(kind, accelerator).then(({ ok, ...view }) => {
      setShortcuts(view)
      setFailed(ok ? null : kind)
    }).catch(() => setFailed(kind))
  }, [])

  return { shortcuts, failed, set }
}
