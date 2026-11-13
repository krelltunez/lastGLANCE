import { useEffect } from 'react'
import { desktopBridge } from '@/native/desktop'
import { loadMcpReadData } from './readData'
import { handleMcpRequest, readsPeople, type McpResult } from './readModel'

// The page's half of the MCP request bridge (docs/mcp-and-stream-deck.md,
// 4.2; electron/mcpRendererBridge.ts is the main process's). Main sends
// {id, method, params}; this loads the data, answers through the read model,
// and replies with the same id. A failure is an answer too (`internal`), so a
// bad request never reads as a window that stopped responding. Mounted in the
// main window only: the tray popup is a separate page and never answers.
export async function answerMcpRequest(raw: unknown, load = loadMcpReadData): Promise<McpResult & { id: number } | null> {
  const req = raw as { id?: unknown; method?: unknown; params?: unknown } | null
  if (!req || typeof req.id !== 'number' || typeof req.method !== 'string') return null
  try {
    if (req.method === 'ping') return { id: req.id, ok: true, data: { ok: true } }
    const data = await load(readsPeople(req.method))
    return { id: req.id, ...handleMcpRequest(data, { method: req.method, params: req.params }) }
  } catch (e) {
    return { id: req.id, ok: false, error: { code: 'internal', message: e instanceof Error ? e.message : 'The read failed.' } }
  }
}

export function useMcpBridge(): void {
  useEffect(() => {
    const bridge = desktopBridge()
    if (!bridge) return
    return bridge.mcp.onRequest((raw) => {
      void answerMcpRequest(raw).then((response) => { if (response) bridge.mcp.respond(response) })
    })
  }, [])
}
