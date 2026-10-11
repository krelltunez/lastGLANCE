// When this device itself last changed its data.
//
// The Direct Access cycle (directAccessCycle.ts) writes a change made HERE to
// the folder at once, and a change that reached this device by another road
// (GLANCEvault, WebDAV) only after the file has sat unchanged without it for
// RELAY_CONFIRM_MS, so the originating device's own write gets there first and
// two devices do not write the same data on top of each other (dayGLANCE's
// docs/direct-access-sync.md, "Relay rules"). "Made here" is this stamp being
// newer than this device's last write to the file.
//
// The data layer (src/db/queries.ts) stamps it through dirtyTracker.markDirty
// on every write of the app's own; the sync engines write to Dexie directly
// and never pass through there, so an apply from any transport leaves it
// alone. Device-local, never synced.

export const LOCAL_EDIT_KEY = 'lastglance-local-edit-at'

const storage = (): Storage | null => (typeof localStorage === 'undefined' ? null : localStorage)

export function markLocalEdit(now: () => number = Date.now): void {
  try { storage()?.setItem(LOCAL_EDIT_KEY, new Date(now()).toISOString()) } catch { /* private mode / quota */ }
}

export function lastLocalEditAt(): string | null {
  try { return storage()?.getItem(LOCAL_EDIT_KEY) ?? null } catch { return null }
}
