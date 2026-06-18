// Deferred-completion buffer for the GLANCEvault DB transport.
//
// Mirror of deferredChores, one level down the dependency chain. applyCompletion
// Event cannot insert a completion until its chore exists locally (the schema
// needs a numeric chore_id). Vault seq order does NOT guarantee a chore arrives
// before its completions: editing a chore bumps its seq above older completion
// rows, the chore may itself be parked awaiting its category, and writes
// interleave across devices and pull pages. A completion event is insert-only
// and is never re-written, so once the pull cursor advances past it the engine
// never re-lists it — dropping it on a missing chore loses it permanently. That
// was the "received some completions, not all" bug.
//
// So when applyCompletionEvent has to skip, the completion's sync shape is parked
// here, keyed by sync_id, and re-applied once its chore shows up (see
// drainDeferredCompletions in dbEngine.ts). Persisted in localStorage so it
// survives the reload between pull cycles.

import type { SyncCompletionEvent } from './types'

const KEY = 'lastglance-db-deferred-completions'

type Buffer = Record<string, SyncCompletionEvent>

function read(): Buffer {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Buffer) : {}
  } catch {
    return {}
  }
}

function write(buf: Buffer): void {
  if (Object.keys(buf).length === 0) localStorage.removeItem(KEY)
  else localStorage.setItem(KEY, JSON.stringify(buf))
}

// Park a completion whose chore is not present yet.
export function addDeferredCompletion(evt: SyncCompletionEvent): void {
  const buf = read()
  buf[evt.id] = evt
  write(buf)
}

// Drop a completion from the buffer once it has been applied (or deleted).
export function removeDeferredCompletion(syncId: string): void {
  const buf = read()
  if (syncId in buf) {
    delete buf[syncId]
    write(buf)
  }
}

// Drop every parked completion that belongs to the given chore. Used when a
// chore is deleted, so its orphaned completions are not retained forever.
export function removeDeferredCompletionsForChore(choreSyncId: string): void {
  const buf = read()
  let changed = false
  for (const [id, evt] of Object.entries(buf)) {
    if (evt.choreSyncId === choreSyncId) { delete buf[id]; changed = true }
  }
  if (changed) write(buf)
}

// All currently parked completions.
export function getDeferredCompletions(): SyncCompletionEvent[] {
  return Object.values(read())
}
