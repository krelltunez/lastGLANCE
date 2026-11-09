// Local reads and writes shared by both People sync roads. These write Dexie
// directly (never through src/people/queries.ts), so applying a remote change
// never marks it dirty and cannot echo back into a push.

import { db } from '@/db/client'
import type { Table } from 'dexie'
import {
  fromSyncInteraction, fromSyncPerson, fromSyncPersonCircle, fromSyncPersonDate,
  invalidReason, toSyncInteraction, toSyncPerson, toSyncPersonCircle, toSyncPersonDate, uuidRe,
} from './types'
import type { PeoplePayload, SyncPeopleEntity } from './types'

type Kind = SyncPeopleEntity['kind']

interface Row { id?: number; sync_id: string; updated_at: string }

function tableFor(kind: Kind): Table<Row, number> {
  switch (kind) {
    case 'person': return db.people as unknown as Table<Row, number>
    case 'interaction': return db.interactions as unknown as Table<Row, number>
    case 'personDate': return db.personDates as unknown as Table<Row, number>
    case 'personCircle': return db.personCircles as unknown as Table<Row, number>
  }
}

function toRow(e: SyncPeopleEntity): Row {
  switch (e.kind) {
    case 'person': return fromSyncPerson(e)
    case 'interaction': return fromSyncInteraction(e)
    case 'personDate': return fromSyncPersonDate(e)
    case 'personCircle': return fromSyncPersonCircle(e)
  }
}

export const PEOPLE_TABLES = () => [
  db.people, db.interactions, db.personDates, db.personCircles, db.peopleTombstones,
]

// Upserts one entity under entity-grain last-writer-wins on updatedAt: a local
// row at least as new is kept. Invalid entities are dropped with a warning.
// Must run inside a transaction covering PEOPLE_TABLES, or standalone.
export async function upsertPeopleEntity(e: SyncPeopleEntity): Promise<boolean> {
  const reason = invalidReason(e)
  if (reason) {
    console.warn('[lastglance] people sync: dropping invalid entity', reason, e?.id)
    return false
  }
  const table = tableFor(e.kind)
  const existing = await table.where('sync_id').equals(e.id).first()
  if (existing && Date.parse(existing.updated_at) >= Date.parse(e.updatedAt)) return false
  const row = toRow(e)
  if (existing) await table.update(existing.id!, row)
  else await table.add(row)
  return true
}

// Removes a row by sync_id from whichever People table holds it, when the
// deletion is newer than the row's last edit (an edit made after a delete on
// another device wins, like the chore tables). Returns whether a row went.
export async function deletePeopleRow(syncId: string, deletedAt: string): Promise<boolean> {
  for (const kind of ['person', 'interaction', 'personDate', 'personCircle'] as Kind[]) {
    const table = tableFor(kind)
    const existing = await table.where('sync_id').equals(syncId).first()
    if (!existing) continue
    if (Date.parse(deletedAt) <= Date.parse(existing.updated_at)) return false
    await table.delete(existing.id!)
    return true
  }
  return false
}

export async function getLocalPeopleEntity(syncId: string): Promise<SyncPeopleEntity | null> {
  const person = await db.people.where('sync_id').equals(syncId).first()
  if (person) return toSyncPerson(person)
  const interaction = await db.interactions.where('sync_id').equals(syncId).first()
  if (interaction) return toSyncInteraction(interaction)
  const date = await db.personDates.where('sync_id').equals(syncId).first()
  if (date) return toSyncPersonDate(date)
  const circle = await db.personCircles.where('sync_id').equals(syncId).first()
  if (circle) return toSyncPersonCircle(circle)
  return null
}

export function notifyPeopleApplied(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('lg:people-changed'))
}

// The full People snapshot in wire shape: the payload of the People file road,
// and the `people` section of every backup (src/db/queries.ts exportBackup,
// src/sync/engine.ts buildBackupPayload).
export async function buildPeoplePayload(): Promise<PeoplePayload> {
  const [people, interactions, personDates, personCircles, tombstoneRows] = await Promise.all([
    db.people.toArray(),
    db.interactions.toArray(),
    db.personDates.toArray(),
    db.personCircles.toArray(),
    db.peopleTombstones.toArray(),
  ])
  const tombstones: Record<string, string> = {}
  for (const t of tombstoneRows) if (uuidRe.test(t.id)) tombstones[t.id] = t.deleted_at
  return {
    people: people.map(toSyncPerson),
    interactions: interactions.map(toSyncInteraction),
    personDates: personDates.map(toSyncPersonDate),
    personCircles: personCircles.map(toSyncPersonCircle),
    tombstones,
  }
}
