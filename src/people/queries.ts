// People mode data layer. Every write stamps updated_at, marks the row dirty
// for the People vault engine, and announces the change with
// `lg:people-changed`. Remote applies (src/people/sync/*) write Dexie directly
// and never come through here, so they cannot loop back into a push.

import dayjs from 'dayjs'
import { db } from '@/db/client'
import { getMeUserSyncId, getMultiUserEnabled } from '@/multiuser/settings'
import { markPeopleDirty } from './sync/dirtyTracker'
import { normalizeDirection } from './types'
import { reciprocitySignals } from './reciprocity'
import type {
  ContactLink, Interaction, InteractionChannel, InteractionDirection, InteractionSource, Person, PersonCircle,
  PersonDate, PersonDateKind, PersonWithLastInteraction,
} from './types'

export const PEOPLE_CHANGED_EVENT = 'lg:people-changed'
// Fired with the new Interaction as `detail` when one is logged on this
// device (not when one arrives by sync), so the lifeGLANCE send happens once.
export const INTERACTION_LOGGED_EVENT = 'lg:interaction-logged'

function notifyChanged(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(PEOPLE_CHANGED_EVENT))
}

function now(): string {
  return dayjs().toISOString()
}

function requireName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('name is required')
  return trimmed
}

async function tombstone(ids: string[], at: string): Promise<void> {
  if (ids.length) await db.peopleTombstones.bulkPut(ids.map(id => ({ id, deleted_at: at })))
}

// ── People ───────────────────────────────────────────────────────────────────

export interface PersonInput {
  name: string
  nickname?: string | null
  circle_sync_id?: string | null
  target_cadence_days?: number | null
  preferred_channel?: InteractionChannel | null
  details?: string | null
  notify_when_overdue?: boolean
  add_to_dayglance_when_overdue?: boolean
  send_to_lifeglance?: boolean
  // A given id, for a caller that must find its own row on a retry (an MCP create).
  sync_id?: string
}

export async function createPerson(input: PersonInput): Promise<Person> {
  const ts = now()
  const person: Person = {
    sync_id: input.sync_id ?? crypto.randomUUID(),
    name: requireName(input.name),
    nickname: input.nickname ?? null,
    circle_sync_id: input.circle_sync_id ?? null,
    target_cadence_days: input.target_cadence_days ?? null,
    preferred_channel: input.preferred_channel ?? null,
    details: input.details ?? null,
    archived: false,
    snoozed_until: null,
    notify_when_overdue: input.notify_when_overdue ?? false,
    add_to_dayglance_when_overdue: input.add_to_dayglance_when_overdue ?? false,
    send_to_lifeglance: input.send_to_lifeglance ?? false,
    owner_user_sync_id: getMultiUserEnabled() ? getMeUserSyncId() : null,
    created_at: ts,
    updated_at: ts,
  }
  person.id = await db.people.add(person)
  markPeopleDirty(person.sync_id)
  notifyChanged()
  return person
}

export type PersonPatch = Partial<Pick<Person,
  'name' | 'nickname' | 'circle_sync_id' | 'target_cadence_days' | 'preferred_channel' |
  'details' | 'archived' | 'snoozed_until' | 'notify_when_overdue' |
  'add_to_dayglance_when_overdue' | 'send_to_lifeglance'
>>

export async function updatePerson(syncId: string, patch: PersonPatch): Promise<void> {
  const existing = await db.people.where('sync_id').equals(syncId).first()
  if (!existing) return
  const fields: PersonPatch & { updated_at: string } = { ...patch, updated_at: now() }
  if (patch.name !== undefined) fields.name = requireName(patch.name)
  await db.people.update(existing.id!, fields)
  markPeopleDirty(syncId)
  notifyChanged()
}

// Deletes a person with their dates and device contact link. Interactions
// that also covered other people keep those people; ones left with nobody go.
export async function deletePerson(syncId: string): Promise<void> {
  const ts = now()
  const dirty: string[] = []
  await db.transaction(
    'rw',
    [db.people, db.personDates, db.interactions, db.contactLinks, db.peopleTombstones],
    async () => {
      const person = await db.people.where('sync_id').equals(syncId).first()
      if (!person) return
      await db.people.delete(person.id!)
      const dead = [syncId]

      const dates = await db.personDates.where('person_sync_id').equals(syncId).toArray()
      await db.personDates.bulkDelete(dates.map(d => d.id!))
      dead.push(...dates.map(d => d.sync_id))

      const interactions = await db.interactions.where('person_sync_ids').equals(syncId).toArray()
      for (const i of interactions) {
        const remaining = i.person_sync_ids.filter(id => id !== syncId)
        if (remaining.length === 0) {
          await db.interactions.delete(i.id!)
          dead.push(i.sync_id)
        } else {
          await db.interactions.update(i.id!, { person_sync_ids: remaining, updated_at: ts })
          dirty.push(i.sync_id)
        }
      }

      await db.contactLinks.delete(syncId)
      await tombstone(dead, ts)
      dirty.push(...dead)
    },
  )
  for (const id of dirty) markPeopleDirty(id)
  notifyChanged()
}

export async function getPerson(syncId: string): Promise<Person | undefined> {
  return db.people.where('sync_id').equals(syncId).first()
}

// Every person with their recency. Archived people are left out unless asked.
export async function getPeople(
  { includeArchived = false }: { includeArchived?: boolean } = {},
): Promise<PersonWithLastInteraction[]> {
  const [people, interactions] = await Promise.all([db.people.toArray(), db.interactions.toArray()])
  const last = new Map<string, Interaction>()
  const byPerson = new Map<string, Interaction[]>()
  for (const i of interactions) {
    for (const pid of i.person_sync_ids) {
      const prev = last.get(pid)
      if (!prev || i.occurred_at > prev.occurred_at) last.set(pid, i)
      const list = byPerson.get(pid)
      if (list) list.push(i)
      else byPerson.set(pid, [i])
    }
  }
  const nowTs = dayjs()
  return people
    .filter(p => includeArchived || !p.archived)
    .map(p => {
      const li = last.get(p.sync_id) ?? null
      const since = li ? li.occurred_at : p.created_at
      const elapsed = nowTs.diff(dayjs(since), 'minute') / (60 * 24)
      return {
        ...p,
        last_interaction_at: li ? li.occurred_at : null,
        last_channel: li ? li.channel : null,
        last_direction: li ? normalizeDirection(li.direction) : null,
        elapsed_days: Math.max(0, Math.round(elapsed * 10) / 10),
        reciprocity: reciprocitySignals(byPerson.get(p.sync_id) ?? [], nowTs),
      }
    })
}

// ── Interactions ─────────────────────────────────────────────────────────────

export interface InteractionInput {
  person_sync_ids: string[]
  channel: InteractionChannel
  direction?: InteractionDirection | null
  occurred_at?: string
  note?: string | null
  source?: InteractionSource
  // A fixed id, so a re-delivered intent logs once (see interactionExists).
  sync_id?: string
}

export async function interactionExists(syncId: string): Promise<boolean> {
  return (await db.interactions.where('sync_id').equals(syncId).count()) > 0
}

// Logs one interaction for one or more people. Logging clears any snooze on
// those people, since the reason to hide them is gone.
export async function logInteraction(input: InteractionInput): Promise<Interaction> {
  const people = [...new Set(input.person_sync_ids)]
  if (people.length === 0) throw new Error('an interaction needs at least one person')
  const ts = now()
  const interaction: Interaction = {
    sync_id: input.sync_id ?? crypto.randomUUID(),
    person_sync_ids: people,
    occurred_at: input.occurred_at ?? ts,
    channel: input.channel,
    direction: input.direction ?? null,
    note: input.note ?? null,
    source: input.source ?? 'manual',
    updated_at: ts,
  }
  const unsnoozed: string[] = []
  await db.transaction('rw', [db.interactions, db.people], async () => {
    interaction.id = await db.interactions.add(interaction)
    for (const pid of people) {
      const p = await db.people.where('sync_id').equals(pid).first()
      if (p && p.snoozed_until) {
        await db.people.update(p.id!, { snoozed_until: null, updated_at: ts })
        unsnoozed.push(pid)
      }
    }
  })
  markPeopleDirty(interaction.sync_id)
  for (const pid of unsnoozed) markPeopleDirty(pid)
  notifyChanged()
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(INTERACTION_LOGGED_EVENT, { detail: interaction }))
  }
  return interaction
}

export type InteractionPatch = Partial<Pick<Interaction,
  'person_sync_ids' | 'occurred_at' | 'channel' | 'direction' | 'note'
>>

export async function updateInteraction(syncId: string, patch: InteractionPatch): Promise<void> {
  const existing = await db.interactions.where('sync_id').equals(syncId).first()
  if (!existing) return
  if (patch.person_sync_ids !== undefined) {
    patch = { ...patch, person_sync_ids: [...new Set(patch.person_sync_ids)] }
    if (patch.person_sync_ids!.length === 0) throw new Error('an interaction needs at least one person')
  }
  await db.interactions.update(existing.id!, { ...patch, updated_at: now() })
  markPeopleDirty(syncId)
  notifyChanged()
}

export async function deleteInteraction(syncId: string): Promise<void> {
  const existing = await db.interactions.where('sync_id').equals(syncId).first()
  if (!existing) return
  await db.transaction('rw', [db.interactions, db.peopleTombstones], async () => {
    await db.interactions.delete(existing.id!)
    await tombstone([syncId], now())
  })
  markPeopleDirty(syncId)
  notifyChanged()
}

// Newest first.
export async function getInteractionsForPerson(personSyncId: string): Promise<Interaction[]> {
  const rows = await db.interactions.where('person_sync_ids').equals(personSyncId).toArray()
  return rows.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
}

// ── Important dates ──────────────────────────────────────────────────────────

export interface PersonDateInput {
  person_sync_id: string
  kind: PersonDateKind
  month: number
  day: number
  year?: number | null
  label?: string | null
  remind_days_before?: number
  // A given id, for a caller that must find its own row on a retry (an MCP create).
  sync_id?: string
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function validateDate(month: number, day: number, year: number | null): void {
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error('invalid month')
  if (!Number.isInteger(day) || day < 1 || day > DAYS_IN_MONTH[month - 1]) throw new Error('invalid day')
  if (year !== null && (!Number.isInteger(year) || year < 1 || year > 9999)) throw new Error('invalid year')
}

export async function addPersonDate(input: PersonDateInput): Promise<PersonDate> {
  const year = input.year ?? null
  validateDate(input.month, input.day, year)
  const row: PersonDate = {
    sync_id: input.sync_id ?? crypto.randomUUID(),
    person_sync_id: input.person_sync_id,
    kind: input.kind,
    label: input.label ?? null,
    month: input.month,
    day: input.day,
    year,
    remind_days_before: Math.max(0, input.remind_days_before ?? 0),
    updated_at: now(),
  }
  row.id = await db.personDates.add(row)
  markPeopleDirty(row.sync_id)
  notifyChanged()
  return row
}

export type PersonDatePatch = Partial<Pick<PersonDate,
  'kind' | 'label' | 'month' | 'day' | 'year' | 'remind_days_before'
>>

export async function updatePersonDate(syncId: string, patch: PersonDatePatch): Promise<void> {
  const existing = await db.personDates.where('sync_id').equals(syncId).first()
  if (!existing) return
  const merged = { ...existing, ...patch }
  validateDate(merged.month, merged.day, merged.year)
  await db.personDates.update(existing.id!, { ...patch, updated_at: now() })
  markPeopleDirty(syncId)
  notifyChanged()
}

export async function deletePersonDate(syncId: string): Promise<void> {
  const existing = await db.personDates.where('sync_id').equals(syncId).first()
  if (!existing) return
  await db.transaction('rw', [db.personDates, db.peopleTombstones], async () => {
    await db.personDates.delete(existing.id!)
    await tombstone([syncId], now())
  })
  markPeopleDirty(syncId)
  notifyChanged()
}

export async function getDatesForPerson(personSyncId: string): Promise<PersonDate[]> {
  const rows = await db.personDates.where('person_sync_id').equals(personSyncId).toArray()
  return rows.sort((a, b) => a.month - b.month || a.day - b.day)
}

// ── Circles ──────────────────────────────────────────────────────────────────

// `syncId` is for a caller that must find its own row on a retry (an MCP create).
export async function createCircle(name: string, icon: string | null = null, syncId?: string): Promise<PersonCircle> {
  const count = await db.personCircles.count()
  const row: PersonCircle = {
    sync_id: syncId ?? crypto.randomUUID(),
    name: requireName(name),
    icon,
    sort_order: count,
    updated_at: now(),
  }
  row.id = await db.personCircles.add(row)
  markPeopleDirty(row.sync_id)
  notifyChanged()
  return row
}

export type CirclePatch = Partial<Pick<PersonCircle, 'name' | 'icon' | 'sort_order'>>

export async function updateCircle(syncId: string, patch: CirclePatch): Promise<void> {
  const existing = await db.personCircles.where('sync_id').equals(syncId).first()
  if (!existing) return
  const fields = { ...patch, updated_at: now() }
  if (patch.name !== undefined) fields.name = requireName(patch.name)
  await db.personCircles.update(existing.id!, fields)
  markPeopleDirty(syncId)
  notifyChanged()
}

// Deletes a circle. Its members stay, ungrouped.
export async function deleteCircle(syncId: string): Promise<void> {
  const ts = now()
  const members: string[] = []
  await db.transaction('rw', [db.personCircles, db.people, db.peopleTombstones], async () => {
    const circle = await db.personCircles.where('sync_id').equals(syncId).first()
    if (!circle) return
    await db.personCircles.delete(circle.id!)
    const people = await db.people.where('circle_sync_id').equals(syncId).toArray()
    for (const p of people) {
      await db.people.update(p.id!, { circle_sync_id: null, updated_at: ts })
      members.push(p.sync_id)
    }
    await tombstone([syncId], ts)
  })
  markPeopleDirty(syncId)
  for (const id of members) markPeopleDirty(id)
  notifyChanged()
}

export async function getCircles(): Promise<PersonCircle[]> {
  return db.personCircles.orderBy('sort_order').toArray()
}

export async function getAllPersonDates(): Promise<PersonDate[]> {
  return db.personDates.toArray()
}

// ── Contact links (device-local) ─────────────────────────────────────────────
// Which phone contact a person is linked to on this device. Contact keys
// differ on every device, so links never sync and nothing here marks dirty.

export async function getContactLinks(): Promise<ContactLink[]> {
  return db.contactLinks.toArray()
}

export async function setContactLink(personSyncId: string, deviceContactKey: string): Promise<void> {
  await db.contactLinks.put({ person_sync_id: personSyncId, device_contact_key: deviceContactKey, last_synced_at: now() })
  notifyChanged()
}

export async function removeContactLink(personSyncId: string): Promise<void> {
  await db.contactLinks.delete(personSyncId)
  notifyChanged()
}

// ── Journal ──────────────────────────────────────────────────────────────────

// Every interaction, newest first, for the People Journal and heatmap.
export async function getAllInteractions(): Promise<Interaction[]> {
  const rows = await db.interactions.toArray()
  return rows.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
}
