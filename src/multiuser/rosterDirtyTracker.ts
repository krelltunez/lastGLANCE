// Bridge between the user writes in src/db/queries.ts and the household roster
// vault engine (src/multiuser/rosterVault.ts), mirroring src/sync/dirtyTracker.ts
// and src/people/sync/dirtyTracker.ts. Separate on purpose: the roster engine
// syncs the shared glance-users vault app with its own dirty set, and must never
// be told about a chore's sync_id. No-op whenever the roster engine is off.

import type { DbSyncEngine } from '@glance-apps/sync'

const PUSH_DEBOUNCE_MS = 3000

let rosterDbEngine: DbSyncEngine | null = null
let pushTimer: ReturnType<typeof setTimeout> | null = null

function cancelScheduledPush(): void {
  if (pushTimer != null) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
}

function schedulePush(): void {
  if (!rosterDbEngine) return
  cancelScheduledPush()
  pushTimer = setTimeout(() => {
    pushTimer = null
    rosterDbEngine?.dbSyncCycle().catch(() => {/* surfaced via the engine onError */})
  }, PUSH_DEBOUNCE_MS)
}

export function registerRosterDbEngine(engine: DbSyncEngine | null): void {
  cancelScheduledPush()
  rosterDbEngine = engine
}

// Run one roster cycle now, for an explicit "Sync now". 'off' when no engine is
// registered; otherwise judged as src/sync/dirtyTracker.ts judges the chore one.
export async function syncRosterNow(): Promise<'ok' | 'failed' | 'off'> {
  const engine = rosterDbEngine
  if (!engine) return 'off'
  cancelScheduledPush()
  const before = engine.getLastSynced()
  try {
    await engine.dbSyncCycle()
  } catch {
    return 'failed'
  }
  const after = engine.getLastSynced()
  return after && after !== before ? 'ok' : 'failed'
}

// Mark a household member changed (or deleted: the engine resolves deletions by
// absence, pushing a soft-delete when getLocalEntity returns null).
export function markRosterDirty(syncId: string | null | undefined): void {
  if (!syncId || !rosterDbEngine) return
  rosterDbEngine.markDirty(syncId)
  schedulePush()
}
