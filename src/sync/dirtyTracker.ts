// Bridge between the data layer (src/db/queries.ts) and the DB sync engine.
//
// The file-tier engine diffs whole entity arrays, so it needs no per-write
// signal. The DB engine, by contrast, only exchanges rows that changed: its
// sole input is markDirty(entityId). This module lets the data layer signal
// dirtiness without importing the engine or React, and is a no-op whenever the
// vault transport is disabled (no engine registered).
//
// It also schedules a debounced vault sync after writes so changes upload
// promptly instead of waiting for the next cadence trigger (load, focus, or the
// 5 minute interval). This is vault only: the file engine keeps its cadence
// model, which is deliberate given its full-payload upload cost.

import type { DbSyncEngine } from '@glance-apps/sync'

// Wait this long after the last write before pushing, so a burst of writes
// (e.g. reordering, a restore, logging several completions) collapses into one
// sync rather than firing per row.
const PUSH_DEBOUNCE_MS = 3000

let dbEngine: DbSyncEngine | null = null
let pushTimer: ReturnType<typeof setTimeout> | null = null

function cancelScheduledPush(): void {
  if (pushTimer != null) {
    clearTimeout(pushTimer)
    pushTimer = null
  }
}

// Debounced vault sync. Each call resets the timer; the cycle runs once the
// writes settle. dbSyncCycle has its own in-flight guard, so this never overlaps
// a cadence-triggered cycle.
function schedulePush(): void {
  if (!dbEngine) return
  cancelScheduledPush()
  pushTimer = setTimeout(() => {
    pushTimer = null
    dbEngine?.dbSyncCycle().catch(() => {/* surfaced via the engine onError */})
  }, PUSH_DEBOUNCE_MS)
}

// Called by App on startup (and on config changes) to wire the active DB engine,
// or null to detach it (vault disabled).
export function registerDbEngine(engine: DbSyncEngine | null): void {
  cancelScheduledPush()
  dbEngine = engine
}

// Mark an entity changed so the DB transport pushes it, and schedule a debounced
// sync. Safe to call from inside the app's own write path: it is synchronous and
// idempotent, and does nothing when the vault transport is off.
export function markDirty(syncId: string | null | undefined): void {
  if (!syncId || !dbEngine) return
  dbEngine.markDirty(syncId)
  schedulePush()
}

// Mark an entity deleted. The DB engine resolves deletions by absence: a dirty
// entity whose getLocalEntity returns null is pushed to the vault as a
// soft-delete. v1.2.0 exposes no dedicated delete call, so this reuses
// markDirty; keeping it as a named helper documents intent at delete sites and
// gives us one place to switch if the engine later gains a delete API.
export function markDeleted(syncId: string | null | undefined): void {
  if (!syncId || !dbEngine) return
  dbEngine.markDirty(syncId)
  schedulePush()
}
