import type { Chore } from '@/types'
import type { SyncChore } from './types'

// What a chore's sync record keeps when the device holding it does not know
// every field in it. Both chore sync paths, the file payload (engine.ts) and
// the GLANCEvault rows (dbEngine.ts), name each field they read and write, so a
// field added by a newer version was dropped twice by an older one: when it
// applied the record (the field never reached its database), and when it built
// its own (the field was not in it). Whichever copy won the merge then won
// without the field, and every device lost it. Two rules here, used by both
// paths:
//
// 1. Fields this version does not know are kept. Applying a record saves them
//    on the local row, in `sync_extra`; building one writes them back, beneath
//    the fields this version owns. A device running this version that edits a
//    chore passes a later version's fields on untouched.
//
// 2. Fields added after rule 1 shipped (LATER_CHORE_FIELDS) are carried
//    forward. Devices from before rule 1 still drop them, and nothing on those
//    devices can change. So for each such field, a record WITHOUT the key is a
//    copy from a device that never knew the field: it says nothing about the
//    field, and the value already held is kept (applying keeps the local
//    value; merging copies it onto the winning copy). This needs every version
//    that knows a field to always write its key, null when it is empty, never
//    leaving it out: an absent key means "unknown", null means "cleared".
//
// A field moves from LATER_CHORE_FIELDS into the known set like any other: it
// is known as soon as this version reads and writes it. Rule 2 is for the
// fields themselves, and stays for as long as devices from before them may
// still edit.

/** Every field of a chore record this version reads and writes. */
export const KNOWN_CHORE_KEYS: ReadonlySet<string> = new Set([
  'id', 'name', 'categorySyncId', 'sortOrder', 'targetCadenceDays', 'notifyWhenOverdue', 'autoScheduleToDayglance',
  'preferredScheduleBehavior', 'seasonalStart', 'seasonalEnd', 'details', 'pinned', 'icon', 'assignedUserSyncIds',
  'createdAt', 'updatedAt',
])

/**
 * The record fields added after unknown fields began to be kept (rule 2), each
 * to its column on the local row: a record without one of these keys came from
 * a device that never knew it. Each is also in KNOWN_CHORE_KEYS, and is written
 * by laterChoreFields, which always writes the key.
 */
export const LATER_CHORE_FIELDS: Readonly<Record<string, keyof Chore>> = {}

type Rec = Record<string, unknown>

/** The fields of a received record this version does not know, or undefined when there are none. */
export function unknownChoreFields(record: SyncChore, known: ReadonlySet<string> = KNOWN_CHORE_KEYS): Rec | undefined {
  const extra: Rec = {}
  for (const [k, v] of Object.entries(record as unknown as Rec)) if (!known.has(k) && v !== undefined) extra[k] = v
  return Object.keys(extra).length ? extra : undefined
}

/** A record built from a local row, with the fields it was received with that this version does not know, beneath its own. */
export function withUnknownFields(record: SyncChore, row: Pick<Chore, 'sync_extra'>): SyncChore {
  return row.sync_extra ? { ...row.sync_extra, ...record } as SyncChore : record
}

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** The later fields of a local row, for a record this version builds: every key written, null when empty. */
export function laterChoreFields(row: Partial<Chore>, later: Readonly<Record<string, string>> = LATER_CHORE_FIELDS): Rec {
  const out: Rec = {}
  for (const [field, column] of Object.entries(later)) out[field] = (row as Rec)[column] ?? null
  return out
}

/**
 * What applying a record does to the later fields of the local row (rule 2):
 * the columns to set, from the fields the record has (null included), and
 * whether a field it lacks left a value in place on the row, which the
 * record's sender never knew about.
 */
export function applyLaterChoreFields(
  record: SyncChore,
  existing: Partial<Chore> | undefined,
  later: Readonly<Record<string, string>> = LATER_CHORE_FIELDS,
): { columns: Rec; kept: boolean } {
  const columns: Rec = {}
  let kept = false
  for (const [field, column] of Object.entries(later)) {
    if (has(record, field)) columns[column] = (record as unknown as Rec)[field] ?? null
    else if (existing && (existing as Rec)[column] != null) kept = true
  }
  return { columns, kept }
}

/**
 * The merge's winning copy of a chore with the later fields it lacks taken
 * from the other copy (rule 2), and whether that changed it. Fields the winner
 * has, null included, are its own.
 */
export function carryLaterFields(winner: Rec, other: Rec | undefined, later: Readonly<Record<string, string>> = LATER_CHORE_FIELDS): { record: Rec; changed: boolean } {
  if (!other) return { record: winner, changed: false }
  let record = winner
  for (const f of Object.keys(later)) {
    if (!has(winner, f) && has(other, f)) {
      record = { ...record, [f]: other[f] }
    }
  }
  return { record, changed: record !== winner }
}
