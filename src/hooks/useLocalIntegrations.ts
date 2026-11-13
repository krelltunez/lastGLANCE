import { useCallback, useEffect, useState } from 'react'
import {
  desktopBridge, type DesktopIntegrationsAction, type DesktopLocalIntegrationsView, type DesktopMcpJournalSnapshot, type DesktopMcpUndoResult,
} from '@/native/desktop'

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

/**
 * What assistants changed this session (the MCP write journal, kept by main),
 * and undo: one item's changes, or all of them. Null until read, and always
 * off the desktop. `result` is the last undo's outcome, for the panel to say.
 */
export function useMcpJournal(): {
  journal: DesktopMcpJournalSnapshot | null
  result: DesktopMcpUndoResult | null
  undo: (groupKey: string | null) => Promise<void>
} {
  const [journal, setJournal] = useState<DesktopMcpJournalSnapshot | null>(null)
  const [result, setResult] = useState<DesktopMcpUndoResult | null>(null)

  useEffect(() => {
    const bridge = desktopBridge()
    if (!bridge) return
    let live = true
    bridge.mcpJournal.get().then((j) => { if (live && j) setJournal(j) }).catch(() => {})
    const off = bridge.mcpJournal.onChanged((j) => { if (live && j) setJournal(j as DesktopMcpJournalSnapshot) })
    return () => { live = false; off() }
  }, [])

  const undo = useCallback(async (groupKey: string | null) => {
    const bridge = desktopBridge()
    if (!bridge) return
    try {
      setResult(await bridge.mcpJournal.undo(groupKey))
    } catch {
      setResult({ ok: false, error: 'unavailable' })
    }
  }, [])

  return { journal, result, undo }
}
