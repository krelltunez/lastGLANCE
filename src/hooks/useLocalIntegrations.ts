import { useCallback, useEffect, useState } from 'react'
import { desktopBridge, type DesktopIntegrationsAction, type DesktopLocalIntegrationsView } from '@/native/desktop'

// The MCP server and Stream Deck switches (docs/mcp-and-stream-deck.md,
// section 3), kept by the main process. Null until read, and always off the
// desktop. `error` is the last refused change's reason, cleared by the next
// change that goes through.
export function useLocalIntegrations(): {
  view: DesktopLocalIntegrationsView | null
  error: string | null
  apply: (action: DesktopIntegrationsAction) => Promise<boolean>
} {
  const [view, setView] = useState<DesktopLocalIntegrationsView | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const bridge = desktopBridge()
    if (!bridge) return
    let live = true
    bridge.localIntegrations.get().then((v) => { if (live && v) setView(v) }).catch(() => {})
    const off = bridge.localIntegrations.onStatus((v) => { if (live && v) setView(v as DesktopLocalIntegrationsView) })
    return () => { live = false; off() }
  }, [])

  const apply = useCallback(async (action: DesktopIntegrationsAction): Promise<boolean> => {
    const bridge = desktopBridge()
    if (!bridge) return false
    try {
      const result = await bridge.localIntegrations.transition(action)
      if (result.view) setView(result.view)
      setError(result.ok ? null : result.error)
      return result.ok
    } catch {
      setError('unavailable')
      return false
    }
  }, [])

  return { view, error, apply }
}
