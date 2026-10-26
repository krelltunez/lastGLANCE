// The headless refresh (docs/launcher-integration.md, "Freshness"): what the
// Android shell runs in an Activity-less WebView, on the launcher's REFRESH,
// while the app's process is dead. One cycle of every sync road the app's own
// REFRESH runs (App.tsx runLauncherSyncCycle: chores and People, file and
// vault), then the launcher's queued writes are applied and, when any changed
// something, the roads run again to push them; then the launcher snapshot and
// heartbeat are re-pushed and the outcome is reported to the worker.
//
// An ALLOWLIST, not App with features switched off. It loads only the sync
// keys, the four engines and the snapshot builder, all of which read and write
// the app's own IndexedDB and localStorage (the WebView shares the app's
// origin), and the launcher's write queue, applied with the app's own handlers
// (src/intents/launcherQueue.ts). Nothing else initialises: no UI, reminders,
// widgets, automation intents, Direct Access or SSE (a launcher completion
// applied here sends no NOTIFY broadcast: that is a Capacitor plugin, and it was
// always best-effort). The native side holds the same line: HeadlessBridge.kt
// exposes only HEADLESS_BRIDGE_METHODS.
//
// The reverse lock: if the user opens the app mid-run, the shell destroys this
// WebView before the live one loads (LauncherRefreshWorker.abortForLiveInstance),
// and the run also asks `headlessShouldAbort` at each phase boundary. Signal
// abort, not wait: the app's own start runs a cycle anyway. A run's only local
// edits are launcher writes, each taken off the native queue only once its
// handler has landed it: one the abort cut short is still queued for the app,
// and one landed but not yet pushed is pushed by the app's own first cycle.

import { hasDbRootKey, initDbRootKey } from '@glance-apps/sync'
import { createEngine, initSessionKey, CRYPTO_CONFIG, DB_CRYPTO_CONFIG } from '@/sync/engine'
import { createDbEngine } from '@/sync/dbEngine'
import { isVaultEnabled } from '@/sync/vaultConfig'
import { createPeopleFileEngine } from '@/people/sync/fileEngine'
import { createPeopleDbEngine } from '@/people/sync/dbEngine'
import { configureLauncherHeartbeat, latestSyncedAt, pushLauncherSnapshotNow } from '@/hooks/useLauncherSnapshot'
import { ackLauncherIntents, drainLauncherIntents } from '@/native/launcherBridge'
import { drainLauncherQueue } from '@/intents/launcherQueue'
import { buildIntentContext } from '@/intents/intentContext'
import { HEADLESS_OUTCOMES, type HeadlessBridge, type HeadlessOutcome } from './headlessMode'

// One sync road: its name in the outcome's reason, and one cycle.
export interface HeadlessRoad {
  name: string
  run: () => Promise<unknown>
}

export interface HeadlessRoads {
  roads: HeadlessRoad[]
  // The heartbeat's syncedAt once the roads have run.
  syncedAt: () => string | null
}

// Engines report failures through callbacks rather than by throwing; a road
// reports its latest message (null clears, as each cycle does at its start).
export type ReportError = (road: string, message: string | null) => void

export interface HeadlessDeps {
  bridge: HeadlessBridge
  buildRoads?: (report: ReportError) => Promise<HeadlessRoads>
  pushSnapshot?: () => Promise<void>
  // Applies the launcher's queued writes; resolves with how many changed something.
  applyWrites?: () => Promise<number>
  now?: () => number
}

export interface HeadlessResult {
  clientId: string
  outcome: HeadlessOutcome
  reason?: string
  durationMs: number
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e))

// The four roads, built the way App builds them, with every callback reduced
// to the error report. Keys first: App starts its engines while the keys load,
// which a single cycle cannot afford (an engine that finds no key yet reports a
// passphrase prompt).
export async function buildSyncRoads(report: ReportError): Promise<HeadlessRoads> {
  await initSessionKey(CRYPTO_CONFIG).catch(() => false)
  if (isVaultEnabled() && !hasDbRootKey()) await initDbRootKey(DB_CRYPTO_CONFIG).catch(() => false)

  const proxyUrl = import.meta.env.VITE_WEBDAV_PROXY_URL
  const file = createEngine(proxyUrl, {
    onStatusChange: () => {},
    onError: (msg) => report('file', msg),
    onLastSyncedChange: () => {},
    onPassphraseRequired: () => report('file', 'passphrase required'),
  })
  const vault = createDbEngine({
    onError: (msg, code) => report('vault', code === 'PASSPHRASE_REQUIRED' ? 'passphrase required' : msg),
  })
  const peopleFile = createPeopleFileEngine(proxyUrl, file, { onError: (msg) => report('people file', msg) })
  const peopleVault = createPeopleDbEngine({ onError: (msg) => report('people vault', msg) })

  const roads: HeadlessRoad[] = [{ name: 'file', run: () => file.sync() }]
  if (vault) roads.push({ name: 'vault', run: () => vault.dbSyncCycle() })
  roads.push({ name: 'people file', run: () => peopleFile.sync() })
  if (peopleVault) roads.push({ name: 'people vault', run: () => peopleVault.dbSyncCycle() })
  return {
    roads,
    syncedAt: () => latestSyncedAt([file.getLastSynced?.(), vault?.getLastSynced?.()]),
  }
}

// The launcher's queued writes, through the app's handlers and ledger. A
// REFRESH in the queue is this run, so only writes are handled.
export async function applyLauncherWrites(): Promise<number> {
  const results = await drainLauncherQueue({
    entries: await drainLauncherIntents(),
    ctx: () => buildIntentContext(undefined, 'GLANCElauncher'),
    ack: ackLauncherIntents,
  })
  return results.filter(r => r.result.success && !r.result.deduped).length
}

// One run: roads, launcher writes (then the roads again to push them), snapshot, outcome. Reports through `headlessDone` and
// resolves with the same record; never throws.
export async function runHeadlessRefresh(clientId: string, deps: HeadlessDeps): Promise<HeadlessResult> {
  const { bridge, buildRoads = buildSyncRoads, pushSnapshot = pushLauncherSnapshotNow, applyWrites = applyLauncherWrites, now = Date.now } = deps
  const started = now()
  const errors = new Map<string, string | null>()
  const report: ReportError = (road, message) => { errors.set(road, message || null) }

  const done = (outcome: HeadlessOutcome, reason?: string): HeadlessResult => {
    const result: HeadlessResult = { clientId, outcome, durationMs: now() - started, ...(reason ? { reason } : {}) }
    try { bridge.headlessDone(JSON.stringify(result)) } catch { /* the worker decides on its cap */ }
    return result
  }
  const shouldAbort = () => { try { return bridge.headlessShouldAbort() } catch { return false } }

  try {
    if (shouldAbort()) return done(HEADLESS_OUTCOMES.ABORTED, 'app opened')
    const { roads, syncedAt } = await buildRoads(report)
    if (shouldAbort()) return done(HEADLESS_OUTCOMES.ABORTED, 'app opened')
    const runRoads = () => Promise.all(roads.map(road => road.run().catch((e: unknown) => report(road.name, messageOf(e)))))
    await runRoads()
    if (shouldAbort()) return done(HEADLESS_OUTCOMES.ABORTED, 'app opened')
    // After the pull, as the app's drain sees it. A write that failed to apply
    // stays out of the ledger, and the launcher re-sends it.
    const applied = await applyWrites().catch(() => 0)
    if (applied > 0) {
      if (shouldAbort()) return done(HEADLESS_OUTCOMES.ABORTED, 'app opened')
      await runRoads()
      if (shouldAbort()) return done(HEADLESS_OUTCOMES.ABORTED, 'app opened')
    }
    // Pushed whatever the roads did: one that failed may sit beside one that
    // applied, and the heartbeat's checkedAt records the look either way.
    configureLauncherHeartbeat(syncedAt)
    await pushSnapshot()
    const failed = [...errors].filter((entry): entry is [string, string] => !!entry[1])
    if (failed.length) return done(HEADLESS_OUTCOMES.FAILED, failed.map(([road, msg]) => `${road}: ${msg}`).join('; '))
    return done(HEADLESS_OUTCOMES.RAN)
  } catch (e) {
    return done(HEADLESS_OUTCOMES.FAILED, messageOf(e))
  }
}
