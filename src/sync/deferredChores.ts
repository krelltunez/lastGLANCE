// Deferred-chore buffer for the GLANCEvault DB transport.
//
// The DB engine pulls rows incrementally and advances a high water mark, so a
// row is only ever seen once. applyChore cannot insert a new chore until its
// category exists locally (the schema needs a numeric category_id and the app
// queries chores by it). Vault seq order does not guarantee a category arrives
// before its chores: editing a category bumps its seq above older chore rows,
// and writes interleave across devices and pull pages. Without a buffer a chore
// that arrives before its category would be skipped permanently.
//
// So when applyChore has to skip, the chore's sync shape is parked here, keyed
// by sync_id, and re-applied once its category shows up (see drainDeferredChores
// in dbEngine.ts). The buffer is persisted in localStorage so it survives the
// reload between pull cycles.

import type { SyncChore } from './types'

const KEY = 'lastglance-db-deferred-chores'

type Buffer = Record<string, SyncChore>

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

// Park a chore whose category is not present yet.
export function addDeferredChore(chore: SyncChore): void {
  const buf = read()
  buf[chore.id] = chore
  write(buf)
}

// Drop a chore from the buffer once it has been applied (or deleted).
export function removeDeferredChore(syncId: string): void {
  const buf = read()
  if (syncId in buf) {
    delete buf[syncId]
    write(buf)
  }
}

// All currently parked chores.
export function getDeferredChores(): SyncChore[] {
  return Object.values(read())
}
