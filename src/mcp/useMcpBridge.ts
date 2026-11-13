import { useEffect, useRef } from 'react'
import { desktopBridge } from '@/native/desktop'
import { addActivityEntry } from '@/intents/config'
import { getMeUserSyncId } from '@/multiuser/settings'
import { loadMcpReadData } from './readData'
import { handleMcpRequest, readsPeople, type McpResult } from './readModel'
import { handleMcpWrite, isWriteMethod, type WriteContext, type WriteResult } from './writeModel'

// The page's half of the MCP request bridge (docs/mcp-and-stream-deck.md,
// 4.2 and 4.5; electron/mcpRendererBridge.ts is the main process's). Main
// sends {id, method, params}; a read is answered by the read model from the
// database, a write by the write model through the data layer. The reply
// carries the same id; a write's undo record rides beside its data for main's
// journal. A failure is an answer too (`internal`), so a bad request never
// reads as a window that stopped responding. Mounted in the main window only:
// the tray popup is a separate page and never answers.

export interface AnswerDeps {
  load?: typeof loadMcpReadData
  write?: (method: string, params: unknown) => Promise<WriteResult>
}

export async function answerMcpRequest(raw: unknown, deps: AnswerDeps = {}): Promise<(McpResult | WriteResult) & { id: number } | null> {
  const req = raw as { id?: unknown; method?: unknown; params?: unknown } | null
  if (!req || typeof req.id !== 'number' || typeof req.method !== 'string') return null
  try {
    if (req.method === 'ping') return { id: req.id, ok: true, data: { ok: true } }
    if (isWriteMethod(req.method)) {
      if (!deps.write) return { id: req.id, ok: false, error: { code: 'internal', message: 'Writes are not answered here.' } }
      return { id: req.id, ...await deps.write(req.method, req.params) }
    }
    const data = await (deps.load ?? loadMcpReadData)(readsPeople(req.method))
    return { id: req.id, ...handleMcpRequest(data, { method: req.method, params: req.params }) }
  } catch (e) {
    return { id: req.id, ok: false, error: { code: 'internal', message: e instanceof Error ? e.message : 'The request failed.' } }
  }
}

/** The write context the app gives the write model: the same signals the intents path sends. */
export function appWriteContext(onChanged?: () => void): WriteContext {
  return {
    meUserSyncId: getMeUserSyncId(),
    now: () => new Date(),
    changed: () => {
      // What the Ribbon, Journal, widgets, launcher snapshot and reminders listen for.
      window.dispatchEvent(new Event('lg:chore-logged'))
      onChanged?.()
    },
    activity: (message) => addActivityEntry({ type: 'received', message }),
  }
}

/** `onChanged` refreshes derived UI (the heatmap), as for the desktop command queue. */
export function useMcpBridge(onChanged?: () => void): void {
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  useEffect(() => {
    const bridge = desktopBridge()
    if (!bridge) return
    // Writes run one at a time, in arrival order: each reads the state the one before it left.
    let queue: Promise<unknown> = Promise.resolve()
    const write = (method: string, params: unknown) => {
      const run = queue.then(() => handleMcpWrite(method, params, appWriteContext(() => onChangedRef.current?.())))
      queue = run.catch(() => {})
      return run
    }
    return bridge.mcp.onRequest((raw) => {
      void answerMcpRequest(raw, { write }).then((response) => { if (response) bridge.mcp.respond(response) })
    })
  }, [])
}
