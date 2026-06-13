// Bridge between the data layer (src/db/queries.ts) and the DB sync engine.
//
// The file-tier engine diffs whole entity arrays, so it needs no per-write
// signal. The DB engine, by contrast, only exchanges rows that changed: its
// sole input is markDirty(entityId). This module lets the data layer signal
// dirtiness without importing the engine or React, and is a no-op whenever the
// vault transport is disabled (no engine registered).

import type { DbSyncEngine } from '@glance-apps/sync'

let dbEngine: DbSyncEngine | null = null

// Called by App on startup (and on config changes) to wire the active DB engine,
// or null to detach it (vault disabled).
export function registerDbEngine(engine: DbSyncEngine | null): void {
  dbEngine = engine
}

// Mark an entity changed so the DB transport pushes it on the next cycle.
// Safe to call from inside the app's own write path: it is synchronous and
// idempotent, and does nothing when the vault transport is off.
export function markDirty(syncId: string | null | undefined): void {
  if (!syncId || !dbEngine) return
  dbEngine.markDirty(syncId)
}

// Mark an entity deleted. The DB engine resolves deletions by absence: a dirty
// entity whose getLocalEntity returns null is pushed to the vault as a
// soft-delete. v1.2.0 exposes no dedicated delete call, so this reuses
// markDirty; keeping it as a named helper documents intent at delete sites and
// gives us one place to switch if the engine later gains a delete API.
export function markDeleted(syncId: string | null | undefined): void {
  if (!syncId || !dbEngine) return
  dbEngine.markDirty(syncId)
}
