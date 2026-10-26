// Draining the GLANCElauncher's queue (docs/launcher-integration.md), for the
// app's bridge hook and the headless run alike. The native queue keeps each
// write until it is acknowledged (launcher/LauncherWriteQueue.kt), so a page
// that stalls in the background, or is closed or killed, before a write's
// handler has finished leaves it for the next page or run, which dedupes on
// the id. A write is acknowledged once its handler returns: the handlers await
// their database writes, so returning is landing.

import type { IntentContext, IntentResult } from './handleIntent'
import { handleLauncherIntent, LAUNCHER_ACTION_MAP, REFRESH, type LauncherRefreshHooks, type LauncherWrite } from './launcherWrites'

export interface DrainedWrite {
  clientId: string
  action: string
  result: IntentResult
}

export interface DrainOptions {
  entries: LauncherWrite[]
  // The handler context, built per write.
  ctx: () => IntentContext
  // Takes handled writes off the native queue, by clientId.
  ack: (ids: string[]) => Promise<void> | void
  // REFRESH entries' hooks; refreshes are skipped when absent (the headless run is the refresh).
  hooks?: LauncherRefreshHooks
  cancelled?: () => boolean
}

export const isRefreshEntry = (entry: LauncherWrite): boolean => LAUNCHER_ACTION_MAP[entry.action] === REFRESH

// Writes first, then refreshes: a REFRESH awaits every sync road, which a page
// in the background can stall on for hours, and a write queued behind it must
// not wait on it. Resolves with each write's result, in order.
export async function drainLauncherQueue({ entries, ctx, ack, hooks, cancelled = () => false }: DrainOptions): Promise<DrainedWrite[]> {
  const results: DrainedWrite[] = []
  for (const write of entries.filter(e => !isRefreshEntry(e))) {
    if (cancelled()) return results
    const clientId = write.clientId ?? ''
    let result: IntentResult
    try {
      result = await handleLauncherIntent(write, ctx())
    } catch (e) {
      result = { success: false, error: e instanceof Error ? e.message : String(e) }
    }
    results.push({ clientId, action: write.action, result })
    // Handled, or refused: off the queue either way. A refused write is not in
    // the ledger, so the launcher re-sends it, as before.
    if (clientId) await ack([clientId])
  }
  if (!hooks) return results
  for (const refresh of entries.filter(isRefreshEntry)) {
    if (cancelled()) return results
    try {
      await handleLauncherIntent(refresh, ctx(), {}, hooks)
    } catch {
      // A REFRESH reports its own outcome into the native log.
    }
  }
  return results
}
