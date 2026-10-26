import { registerPlugin } from '@capacitor/core'
import { isAndroid } from './platform'
import { headlessBridge } from '@/headless/headlessMode'

// Native bridge to the GLANCElauncher integration (docs/launcher-integration.md).
// The web app pushes the launcher snapshot here and the native LauncherProvider
// serves it read-only; the launcher's writes land in a native queue through
// LauncherIntentReceiver and are drained here. Android only: the launcher is an
// Android home screen, and no plugin is registered elsewhere.
export interface LauncherBridgePlugin {
  // Persist the launcher snapshot JSON and notify the provider's observers.
  updateSnapshot(options: { json: string }): Promise<void>
  // Return the queued launcher entries, a JSON array string of
  // `{ action, payload, clientId, receivedAt }` in arrival order. The writes
  // stay queued until acknowledged (ackIntents); a REFRESH is taken off.
  drainPendingIntents(): Promise<{ intents: string }>
  // Take the handled writes (`ids`, a JSON array of client ids) off the queue.
  ackIntents(options: { ids: string }): Promise<void>
  // Merge the heartbeat ({ checkedAt, syncedAt }) and notify the provider's observers.
  touchHeartbeat(options: { json: string }): Promise<void>
  // Record a REFRESH's outcome ({ clientId, outcome, reason?, durationMs }) in the native log.
  recordRefresh(options: { json: string }): Promise<void>
}

const LauncherBridge = registerPlugin<LauncherBridgePlugin>('LauncherBridge')

export interface LauncherIntent {
  action: string
  payload: Record<string, unknown>
  clientId: string
}

// A headless refresh (src/headless/) pushes through the shell's HeadlessBridge:
// there is no Capacitor bridge in its WebView.
export async function pushLauncherSnapshot(json: string): Promise<void> {
  const headless = headlessBridge()
  if (headless) {
    headless.updateLauncherSnapshot(json)
    return
  }
  if (!isAndroid()) return
  try {
    await LauncherBridge.updateSnapshot({ json })
  } catch {
    // An older shell without the plugin, or a transient bridge error: the
    // launcher shows its last snapshot, the app is unaffected.
  }
}

// Reads the launcher queue: its writes stay queued until ackLauncherIntents
// (src/intents/launcherQueue.ts). Entries without a string action or clientId
// are dropped (the receiver never stores such a thing, so one here is
// corruption, not a write). Empty off Android or on any error. A headless run
// reads it through the shell's HeadlessBridge.
export async function drainLauncherIntents(): Promise<LauncherIntent[]> {
  const headless = headlessBridge()
  if (!headless && !isAndroid()) return []
  try {
    const raw = headless ? headless.takeLauncherIntents() : (await LauncherBridge.drainPendingIntents())?.intents
    const parsed = JSON.parse(raw || '[]') as unknown
    if (!Array.isArray(parsed)) return []
    const out: LauncherIntent[] = []
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue
      const obj = entry as Record<string, unknown>
      if (typeof obj.action !== 'string' || typeof obj.clientId !== 'string' || !obj.clientId) continue
      const payload = (obj.payload && typeof obj.payload === 'object' ? obj.payload : {}) as Record<string, unknown>
      out.push({ action: obj.action, payload, clientId: obj.clientId })
    }
    return out
  } catch {
    return []
  }
}

// Takes handled launcher writes off the native queue. Best-effort: one that
// stays is delivered again, and the ledger dedupes it.
export async function ackLauncherIntents(ids: string[]): Promise<void> {
  if (!ids.length) return
  const headless = headlessBridge()
  try {
    if (headless) headless.ackLauncherIntents(JSON.stringify(ids))
    else if (isAndroid()) await LauncherBridge.ackIntents({ ids: JSON.stringify(ids) })
  } catch {
    // An older shell without the method cleared the queue on read.
  }
}

export interface LauncherHeartbeat {
  // When the app last looked (ms since the epoch).
  checkedAt: number
  // When a sync road last completed a cycle (ISO), or null without one.
  syncedAt: string | null
}

export type RefreshOutcome = 'ran' | 'failed'

export interface RefreshRecord {
  clientId: string
  outcome: RefreshOutcome
  reason?: string
  durationMs: number
}

// The heartbeat (docs/launcher-integration.md, "Freshness"): written on every
// run of the snapshot builder, changed or not, so the launcher measures
// staleness from the last confirmation rather than the last change.
export async function touchLauncherHeartbeat(heartbeat: LauncherHeartbeat): Promise<void> {
  const headless = headlessBridge()
  if (headless) {
    headless.touchLauncherHeartbeat(JSON.stringify(heartbeat))
    return
  }
  if (!isAndroid()) return
  try {
    await LauncherBridge.touchHeartbeat({ json: JSON.stringify(heartbeat) })
  } catch {
    // An older shell without the method: the launcher measures from updatedAt.
  }
}

export async function recordLauncherRefresh(record: RefreshRecord): Promise<void> {
  if (!isAndroid()) return
  try {
    await LauncherBridge.recordRefresh({ json: JSON.stringify(record) })
  } catch {
    // Best-effort: the log is diagnostics, not state.
  }
}
