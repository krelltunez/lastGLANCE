import dayjs from 'dayjs'
import { db } from '@/db/client'
import {
  addPersonDate, createCircle, createPerson, deleteCircle, deleteInteraction, deletePerson, deletePersonDate, getPeople,
  logInteraction, updateCircle, updateInteraction, updatePerson, updatePersonDate,
  type InteractionPatch, type PersonDatePatch, type PersonPatch,
} from '@/people/queries'
import { snoozeUntil, suggestedChannel } from '@/people/home'
import {
  INTERACTION_CHANNELS, INTERACTION_DIRECTIONS, normalizeDirection,
  type Interaction, type InteractionChannel, type InteractionDirection, type Person, type PersonCircle, type PersonDate,
  type PersonDateKind, type PersonWithLastInteraction,
} from '@/people/types'
import { handleMcpRequest } from './readModel'
import { loadMcpReadData } from './readData'
import {
  bool, checkName, checkPosition, checkText, has, idFromSeed, obj, ok as okShared, quote, refuse,
  type UndoRecord, type WriteContext, type WriteResult,
} from './writeShared'

// The MCP write model for People (docs/mcp-and-stream-deck.md, 4.5; phase 3b).
// The same contract as the chores' (writeModel.ts): each write goes through the
// data-layer calls the People forms make (src/people/queries.ts, which marks
// the rows dirty and fires lg:people-changed), with the forms' rules, and
// returns the entity as the read tools show it plus an undo record.
//
// The rules the People forms apply, applied here (the audit is in
// docs/mcp-tools-reference.md, "What the tools change"):
//  - only this user's People are written, as the People screens show them
//    (visibleToMe): with multi-user on, another member's People do not exist
//    here;
//  - a new person's owner is stamped by the data layer, never by a call;
//  - snoozing offers 3, 7 or 14 days; a date reminds 0, 1, 2, 3, 7 or 14 days
//    ahead; a label is for a custom date only; a contact is never in the
//    future, and logging one clears its people's snooze, as in the app;
//  - nothing is deleted, except by an undo of the write that created it, and
//    an undo keeps anything the user added since.

export type PeopleUndoOp =
  | { kind: 'remove_created_person'; personId: string; dateIds: string[] }
  | { kind: 'restore_person_fields'; personId: string; before: Record<string, unknown> }
  | { kind: 'remove_created_date'; personId: string; dateId: string }
  | { kind: 'restore_date_fields'; personId: string; dateId: string; before: Record<string, unknown> }
  | { kind: 'remove_interaction'; interactionId: string; personIds: string[]; snoozesBefore: Record<string, string> }
  | { kind: 'restore_interaction_fields'; interactionId: string; personIds: string[]; before: Record<string, unknown> }
  | { kind: 'remove_created_circle'; circleId: string }
  | { kind: 'restore_circle_fields'; circleId: string; before: Record<string, unknown>; orderBefore?: string[] }

type Result = WriteResult<PeopleUndoOp>
const ok = (data: Record<string, unknown>, undo?: UndoRecord<PeopleUndoOp>): Result => okShared<PeopleUndoOp>(data, undo)

export const PEOPLE_WRITE_METHODS = [
  'create_person', 'update_person', 'add_person_date', 'update_person_date', 'log_interaction', 'update_interaction',
  'create_circle', 'update_circle',
] as const

export const SNOOZE_CHOICES = [3, 7, 14] as const
export const REMIND_CHOICES = [0, 1, 2, 3, 7, 14] as const
export const DATE_KINDS: readonly PersonDateKind[] = ['birthday', 'anniversary', 'custom']
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
const TEXT_MAX = 5000

// ── Lookups ─────────────────────────────────────────────────────────────────

/** The People this user may write: owned by nobody, or by Me when multi-user is on. */
async function visiblePeople(ctx: WriteContext): Promise<PersonWithLastInteraction[]> {
  const all = await getPeople({ includeArchived: true })
  return ctx.multiUserEnabled && ctx.meUserSyncId
    ? all.filter(p => p.owner_user_sync_id === null || p.owner_user_sync_id === ctx.meUserSyncId)
    : all
}

async function personBySync(id: unknown, ctx: WriteContext): Promise<PersonWithLastInteraction> {
  const p = typeof id === 'string' ? (await visiblePeople(ctx)).find(x => x.sync_id === id) : undefined
  return p ?? refuse('not_found', `No person with id ${JSON.stringify(id)}. Find them with lastglance_list_people.`)
}

async function circleBySync(id: unknown): Promise<PersonCircle> {
  const c = typeof id === 'string' ? await db.personCircles.where('sync_id').equals(id).first() : undefined
  return c ?? refuse('not_found', `No circle with id ${JSON.stringify(id)}. List them with lastglance_list_circles.`)
}

async function dateBySync(id: unknown, ctx: WriteContext): Promise<PersonDate> {
  const d = typeof id === 'string' ? await db.personDates.where('sync_id').equals(id).first() : undefined
  if (!d || !(await visiblePeople(ctx)).some(p => p.sync_id === d.person_sync_id)) {
    refuse('not_found', `No date with id ${JSON.stringify(id)}. A person's dates are in lastglance_get_person.`)
  }
  return d!
}

async function interactionBySync(id: unknown, ctx: WriteContext): Promise<Interaction> {
  const i = typeof id === 'string' ? await db.interactions.where('sync_id').equals(id).first() : undefined
  const mine = new Set((await visiblePeople(ctx)).map(p => p.sync_id))
  // A contact that covers someone this user cannot see is not theirs to edit.
  if (!i || i.person_sync_ids.some(pid => !mine.has(pid))) {
    refuse('not_found', `No contact with id ${JSON.stringify(id)}. A person's contacts are in lastglance_get_person.`)
  }
  return i!
}

// ── Checks ──────────────────────────────────────────────────────────────────

function checkCadence(v: unknown): number | null {
  if (v === null) return null
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 36500) {
    refuse('validation', 'cadence_days must be a whole number of days, 1 or more (the app shows it in weeks: 7 a week), or null for none.')
  }
  return v as number
}

function checkChannel(v: unknown, what = 'channel'): InteractionChannel | null {
  if (v === null) return null
  if (!INTERACTION_CHANNELS.includes(v as InteractionChannel)) refuse('validation', `${what} must be one of ${INTERACTION_CHANNELS.join(', ')}.`)
  return v as InteractionChannel
}

function checkDirection(v: unknown): InteractionDirection | null {
  if (v === null) return null
  if (!INTERACTION_DIRECTIONS.includes(v as InteractionDirection)) refuse('validation', `direction must be one of ${INTERACTION_DIRECTIONS.join(', ')}, or null.`)
  return v as InteractionDirection
}

function checkWhen(v: unknown, ctx: WriteContext): string {
  const at = dayjs(String(v))
  if (typeof v !== 'string' || !at.isValid()) refuse('validation', 'occurred_at must be an ISO 8601 time.')
  if (at.isAfter(dayjs(ctx.now()).add(1, 'minute'))) refuse('validation', 'occurred_at cannot be in the future, as in the app.')
  return at.toISOString()
}

interface DateFields { kind: PersonDateKind; label: string | null; month: number; day: number; year: number | null; remind_days_before: number }

/** A date's fields, merged over what it had: the form's rules, before anything is saved. */
function checkDate(input: Record<string, unknown>, base?: PersonDate): DateFields {
  const kind = (has(input, 'kind') ? input.kind : base?.kind ?? 'birthday') as PersonDateKind
  if (!DATE_KINDS.includes(kind)) refuse('validation', `kind must be one of ${DATE_KINDS.join(', ')}.`)
  const month = has(input, 'month') ? input.month : base?.month
  const day = has(input, 'day') ? input.day : base?.day
  if (typeof month !== 'number' || !Number.isInteger(month) || month < 1 || month > 12) refuse('validation', 'month must be 1-12.')
  if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > DAYS_IN_MONTH[(month as number) - 1]) {
    refuse('validation', `day must be a real day of month ${month} (Feb 29 is allowed).`)
  }
  const year = has(input, 'year') ? input.year : base?.year ?? null
  if (year !== null && (typeof year !== 'number' || !Number.isInteger(year) || year < 1 || year > 9999)) refuse('validation', 'year must be 1-9999, or null when unknown.')
  const remind = has(input, 'remind_days_before') ? input.remind_days_before : base?.remind_days_before ?? 0
  if (!(REMIND_CHOICES as readonly unknown[]).includes(remind)) refuse('validation', `remind_days_before must be one of ${REMIND_CHOICES.join(', ')} (0 is on the day).`)
  // As the form saves it: a label for a custom date only.
  const rawLabel = has(input, 'label') ? input.label : base?.label ?? null
  const label = kind === 'custom' ? checkText(rawLabel, 'label', 200) : null
  return { kind, label, month: month as number, day: day as number, year: year as number | null, remind_days_before: remind as number }
}

// ── Results, as the read tools show them ────────────────────────────────────

async function personResult(syncId: string, ctx: WriteContext): Promise<Record<string, unknown>> {
  const data = { ...(await loadMcpReadData(true)), multiUserEnabled: ctx.multiUserEnabled, meUserSyncId: ctx.meUserSyncId }
  const r = handleMcpRequest(data, { method: 'get_person', params: { person_id: syncId, interactions_limit: 5 } })
  return r.ok ? r.data as Record<string, unknown> : { id: syncId }
}

const interactionItem = (i: Interaction) => ({
  id: i.sync_id, occurred_at: i.occurred_at, channel: i.channel, direction: normalizeDirection(i.direction), note: i.note, source: i.source, person_ids: i.person_sync_ids,
})

const circleItem = (c: PersonCircle) => ({ id: c.sync_id, name: c.name, icon: c.icon })

// ── People ──────────────────────────────────────────────────────────────────

const PERSON_FIELDS = ['name', 'nickname', 'circle_id', 'cadence_days', 'preferred_channel', 'details', 'notify_when_overdue', 'add_to_dayglance_when_overdue', 'send_to_lifeglance', 'archived', 'snooze_days'] as const

/** The tools' person fields as the data layer's patch, checked before anything is saved. `snoozed_until` comes from an undo only. */
async function personPatch(f: Record<string, unknown>, ctx: WriteContext): Promise<PersonPatch> {
  const patch: PersonPatch = {}
  if (has(f, 'name')) patch.name = checkName(f.name)
  if (has(f, 'nickname')) patch.nickname = checkText(f.nickname, 'nickname', 500)
  if (has(f, 'circle_id')) patch.circle_sync_id = f.circle_id === null ? null : (await circleBySync(f.circle_id)).sync_id
  if (has(f, 'cadence_days')) patch.target_cadence_days = checkCadence(f.cadence_days)
  if (has(f, 'preferred_channel')) patch.preferred_channel = checkChannel(f.preferred_channel, 'preferred_channel')
  if (has(f, 'details')) patch.details = checkText(f.details, 'details', TEXT_MAX)
  for (const k of ['notify_when_overdue', 'add_to_dayglance_when_overdue', 'send_to_lifeglance', 'archived'] as const) {
    if (has(f, k)) patch[k] = bool(f[k], k)
  }
  if (has(f, 'snooze_days')) {
    if (f.snooze_days !== null && !(SNOOZE_CHOICES as readonly unknown[]).includes(f.snooze_days)) {
      refuse('validation', `snooze_days must be ${SNOOZE_CHOICES.join(', ')}, as the app offers, or null to end a snooze.`)
    }
    patch.snoozed_until = f.snooze_days === null ? null : snoozeUntil(f.snooze_days as number, dayjs(ctx.now()))
  }
  if (has(f, 'snoozed_until')) patch.snoozed_until = f.snoozed_until as string | null
  return patch
}

/** A person's editable fields under the tools' names, for an undo; a snooze is kept as its end time. */
function personFields(p: Person): Record<string, unknown> {
  return {
    name: p.name, nickname: p.nickname, circle_id: p.circle_sync_id, cadence_days: p.target_cadence_days,
    preferred_channel: p.preferred_channel, details: p.details, notify_when_overdue: !!p.notify_when_overdue,
    add_to_dayglance_when_overdue: !!p.add_to_dayglance_when_overdue, send_to_lifeglance: !!p.send_to_lifeglance,
    archived: p.archived, snoozed_until: p.snoozed_until,
  }
}

async function createPersonWrite(p: Record<string, unknown>, ctx: WriteContext): Promise<Result> {
  const newId = String(p.new_id)
  if (await db.people.where('sync_id').equals(newId).first()) return ok({ person: await personResult(newId, ctx), replayed: true })
  if (has(p, 'archived') || has(p, 'snooze_days')) refuse('validation', 'A new person is never archived or snoozed; change that with lastglance_update_person.')
  const name = checkName(p.name)
  const patch = await personPatch({ ...p, name }, ctx)
  const dates = p.dates === undefined ? [] : Array.isArray(p.dates) ? (p.dates as unknown[]).map(d => checkDate(obj(d))) : refuse('validation', 'dates must be a list.')
  await createPerson({
    sync_id: newId, name,
    nickname: patch.nickname ?? null, circle_sync_id: patch.circle_sync_id ?? null, target_cadence_days: patch.target_cadence_days ?? null,
    preferred_channel: patch.preferred_channel ?? null, details: patch.details ?? null,
    notify_when_overdue: patch.notify_when_overdue ?? false, add_to_dayglance_when_overdue: patch.add_to_dayglance_when_overdue ?? false,
    send_to_lifeglance: patch.send_to_lifeglance ?? false,
  })
  const dateIds: string[] = []
  for (const [i, d] of (dates as DateFields[]).entries()) {
    const row = await addPersonDate({ person_sync_id: newId, ...d, sync_id: await idFromSeed(`${newId}:date:${i}`) })
    dateIds.push(row.sync_id)
  }
  ctx.activity(`Added "${name}" to People via MCP`)
  ctx.changed()
  return ok({ person: await personResult(newId, ctx) }, { summary: `Added ${quote(name)} to People`, op: { kind: 'remove_created_person', personId: newId, dateIds } })
}

async function updatePersonWrite(p: Record<string, unknown>, ctx: WriteContext): Promise<Result> {
  const person = await personBySync(p.person_id, ctx)
  const fields = obj(p.fields)
  const touched = PERSON_FIELDS.filter(k => has(fields, k))
  if (touched.length === 0) refuse('validation', 'Name at least one field to change.')
  const patch = await personPatch(fields, ctx)
  const all = personFields(person)
  const before = Object.fromEntries(touched.map(k => (k === 'snooze_days' ? ['snoozed_until', all.snoozed_until] : [k, all[k]])))
  await updatePerson(person.sync_id, patch)
  ctx.changed()
  const name = patch.name ?? person.name
  return ok({ person: await personResult(person.sync_id, ctx) }, { summary: `Edited ${quote(name)}`, op: { kind: 'restore_person_fields', personId: person.sync_id, before } })
}

// ── Dates ───────────────────────────────────────────────────────────────────

const DATE_FIELDS = ['kind', 'label', 'month', 'day', 'year', 'remind_days_before'] as const

async function addDateWrite(p: Record<string, unknown>, ctx: WriteContext): Promise<Result> {
  const person = await personBySync(p.person_id, ctx)
  const newId = String(p.new_id)
  if (await db.personDates.where('sync_id').equals(newId).first()) return ok({ person: await personResult(person.sync_id, ctx), replayed: true })
  const d = checkDate(p)
  await addPersonDate({ person_sync_id: person.sync_id, ...d, sync_id: newId })
  ctx.changed()
  return ok({ date_id: newId, person: await personResult(person.sync_id, ctx) }, {
    summary: `Added a date for ${quote(person.name)}`, op: { kind: 'remove_created_date', personId: person.sync_id, dateId: newId },
  })
}

async function updateDateWrite(p: Record<string, unknown>, ctx: WriteContext): Promise<Result> {
  const date = await dateBySync(p.date_id, ctx)
  const fields = obj(p.fields)
  const touched = DATE_FIELDS.filter(k => has(fields, k))
  if (touched.length === 0) refuse('validation', 'Name at least one field to change.')
  const merged = checkDate(fields, date)
  const patch: PersonDatePatch = Object.fromEntries(DATE_FIELDS.map(k => [k, merged[k]]))
  const before: Record<string, unknown> = Object.fromEntries(DATE_FIELDS.map(k => [k, date[k]]))
  await updatePersonDate(date.sync_id, patch)
  ctx.changed()
  const person = await db.people.where('sync_id').equals(date.person_sync_id).first()
  return ok({ date_id: date.sync_id, person: await personResult(date.person_sync_id, ctx) }, {
    summary: `Changed a date for ${quote(person?.name ?? 'someone')}`, op: { kind: 'restore_date_fields', personId: date.person_sync_id, dateId: date.sync_id, before },
  })
}

// ── Contacts ────────────────────────────────────────────────────────────────

async function checkPeopleIds(ids: unknown, ctx: WriteContext, forNew: boolean): Promise<PersonWithLastInteraction[]> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(i => typeof i !== 'string')) refuse('validation', 'person_ids must list at least one person id.')
  const visible = new Map((await visiblePeople(ctx)).map(p => [p.sync_id, p]))
  const people = [...new Set(ids as string[])].map(id => visible.get(id) ?? refuse('not_found', `No person with id ${JSON.stringify(id)}. Find them with lastglance_list_people.`))
  // As the log sheet offers them: archived people are not logged with.
  const archived = forNew ? people.find(p => p.archived) : undefined
  if (archived) refuse('validation', `${quote(archived.name)} is archived; unarchive them first with lastglance_update_person.`)
  return people
}

async function logInteractionWrite(p: Record<string, unknown>, ctx: WriteContext): Promise<Result> {
  const newId = String(p.new_id)
  const existing = await db.interactions.where('sync_id').equals(newId).first()
  if (existing) return ok({ interaction: interactionItem(existing), replayed: true })
  const people = await checkPeopleIds(p.person_ids, ctx, true)
  // As the log sheet does: the first person's preferred channel, else the last one used, else in person.
  const channel = p.channel !== undefined ? checkChannel(p.channel) ?? refuse('validation', 'channel is required when given.') : suggestedChannel(people[0]) ?? 'in_person'
  const direction = p.direction !== undefined ? checkDirection(p.direction) : null
  const note = p.note !== undefined ? checkText(p.note, 'note', TEXT_MAX) : null
  const occurred_at = p.occurred_at !== undefined ? checkWhen(p.occurred_at, ctx) : undefined
  // Logging ends a snooze, as in the app; the undo puts it back.
  const snoozesBefore = Object.fromEntries(people.filter(x => x.snoozed_until).map(x => [x.sync_id, x.snoozed_until as string]))
  const logged = await logInteraction({ sync_id: newId, person_sync_ids: people.map(x => x.sync_id), channel: channel as InteractionChannel, direction, note, occurred_at, source: 'intent' })
  const names = people.map(x => x.name).join(', ')
  ctx.activity(`Logged a contact with "${names}" via MCP`)
  ctx.changed()
  return ok({ interaction: interactionItem(logged), people: await Promise.all(people.map(x => personResult(x.sync_id, ctx))) }, {
    summary: `Logged a contact with ${quote(names)}`,
    op: { kind: 'remove_interaction', interactionId: newId, personIds: people.map(x => x.sync_id), snoozesBefore },
  })
}

const INTERACTION_FIELDS = ['person_ids', 'channel', 'direction', 'note', 'occurred_at'] as const

async function interactionPatch(f: Record<string, unknown>, ctx: WriteContext): Promise<InteractionPatch> {
  const patch: InteractionPatch = {}
  if (has(f, 'person_ids')) patch.person_sync_ids = (await checkPeopleIds(f.person_ids, ctx, false)).map(x => x.sync_id)
  if (has(f, 'channel')) patch.channel = checkChannel(f.channel) ?? refuse('validation', 'channel cannot be cleared.')
  if (has(f, 'direction')) patch.direction = checkDirection(f.direction)
  if (has(f, 'note')) patch.note = checkText(f.note, 'note', TEXT_MAX)
  if (has(f, 'occurred_at')) patch.occurred_at = checkWhen(f.occurred_at, ctx)
  return patch
}

async function updateInteractionWrite(p: Record<string, unknown>, ctx: WriteContext): Promise<Result> {
  const i = await interactionBySync(p.interaction_id, ctx)
  const fields = obj(p.fields)
  const touched = INTERACTION_FIELDS.filter(k => has(fields, k))
  if (touched.length === 0) refuse('validation', 'Name at least one field to change.')
  const patch = await interactionPatch(fields, ctx)
  const was: Record<string, unknown> = { person_ids: i.person_sync_ids, channel: i.channel, direction: normalizeDirection(i.direction), note: i.note, occurred_at: i.occurred_at }
  const before = Object.fromEntries(touched.map(k => [k, was[k]]))
  await updateInteraction(i.sync_id, patch)
  ctx.changed()
  const now = (await db.interactions.where('sync_id').equals(i.sync_id).first())!
  return ok({ interaction: interactionItem(now) }, {
    summary: 'Edited a contact',
    op: { kind: 'restore_interaction_fields', interactionId: i.sync_id, personIds: [...new Set([...i.person_sync_ids, ...now.person_sync_ids])], before },
  })
}

// ── Circles ─────────────────────────────────────────────────────────────────

const sortedCircles = async () => (await db.personCircles.toArray()).sort((a, b) => a.sort_order - b.sort_order || a.id! - b.id!)

/** Rewrite every circle's order, as the circle manager does (it also heals duplicate orders). */
async function writeCircleOrder(syncIds: string[]): Promise<void> {
  for (const [idx, id] of syncIds.entries()) await updateCircle(id, { sort_order: idx })
}

async function moveCircle(syncId: string, position: number): Promise<void> {
  const rest = (await sortedCircles()).map(c => c.sync_id).filter(x => x !== syncId)
  rest.splice(Math.min(position, rest.length), 0, syncId)
  await writeCircleOrder(rest)
}

async function createCircleWrite(p: Record<string, unknown>, ctx: WriteContext): Promise<Result> {
  const newId = String(p.new_id)
  const existing = await db.personCircles.where('sync_id').equals(newId).first()
  if (existing) return ok({ circle: circleItem(existing), replayed: true })
  const name = checkName(p.name)
  const position = p.position !== undefined ? checkPosition(p.position) : undefined
  const row = await createCircle(name, null, newId)
  if (position !== undefined) await moveCircle(newId, position)
  ctx.changed()
  return ok({ circle: circleItem(row) }, { summary: `Created the circle ${quote(name)}`, op: { kind: 'remove_created_circle', circleId: newId } })
}

async function updateCircleWrite(p: Record<string, unknown>, ctx: WriteContext): Promise<Result> {
  const circle = await circleBySync(p.circle_id)
  const fields = obj(p.fields)
  const position = p.position !== undefined ? checkPosition(p.position) : undefined
  if (!has(fields, 'name') && position === undefined) refuse('validation', 'Name a new name or a position.')
  const name = has(fields, 'name') ? checkName(fields.name) : undefined
  const orderBefore = position !== undefined ? (await sortedCircles()).map(c => c.sync_id) : undefined
  if (name !== undefined) await updateCircle(circle.sync_id, { name })
  if (position !== undefined) await moveCircle(circle.sync_id, position)
  ctx.changed()
  const now = (await db.personCircles.where('sync_id').equals(circle.sync_id).first())!
  return ok({ circle: circleItem(now) }, {
    summary: `Edited the circle ${quote(name ?? circle.name)}`,
    op: { kind: 'restore_circle_fields', circleId: circle.sync_id, before: name !== undefined ? { name: circle.name } : {}, ...(orderBefore && { orderBefore }) },
  })
}

// ── Undo ────────────────────────────────────────────────────────────────────

/** Reverse one People op. Returns why it was skipped, or null when it was undone. */
export async function undoPeopleOp(op: PeopleUndoOp, ctx: WriteContext): Promise<string | null> {
  switch (op.kind) {
    case 'remove_created_person': {
      const p = await db.people.where('sync_id').equals(op.personId).first()
      if (!p) return 'the person is already gone'
      if (await db.interactions.where('person_sync_ids').equals(op.personId).count()) return 'contacts have been logged with them since, so they were kept'
      const dates = await db.personDates.where('person_sync_id').equals(op.personId).toArray()
      if (dates.some(d => !op.dateIds.includes(d.sync_id))) return 'dates have been added for them since, so they were kept'
      await deletePerson(op.personId)
      return null
    }
    case 'restore_person_fields': {
      const p = await db.people.where('sync_id').equals(op.personId).first()
      if (!p) return 'the person is gone'
      if (op.before.circle_id && !(await db.personCircles.where('sync_id').equals(String(op.before.circle_id)).first())) return 'their old circle is gone'
      await updatePerson(op.personId, await personPatch(op.before, ctx))
      return null
    }
    case 'remove_created_date': {
      if (!(await db.personDates.where('sync_id').equals(op.dateId).first())) return 'the date is already gone'
      await deletePersonDate(op.dateId)
      return null
    }
    case 'restore_date_fields': {
      if (!(await db.personDates.where('sync_id').equals(op.dateId).first())) return 'the date is gone'
      await updatePersonDate(op.dateId, op.before as PersonDatePatch)
      return null
    }
    case 'remove_interaction': {
      if (!(await db.interactions.where('sync_id').equals(op.interactionId).first())) return 'the contact is already gone'
      await deleteInteraction(op.interactionId)
      for (const [pid, until] of Object.entries(op.snoozesBefore)) {
        // Only a snooze still in the future comes back.
        if (dayjs(until).isAfter(dayjs(ctx.now())) && await db.people.where('sync_id').equals(pid).first()) await updatePerson(pid, { snoozed_until: until })
      }
      return null
    }
    case 'restore_interaction_fields': {
      if (!(await db.interactions.where('sync_id').equals(op.interactionId).first())) return 'the contact is gone'
      const b = op.before
      const patch: InteractionPatch = {}
      if (has(b, 'person_ids')) patch.person_sync_ids = b.person_ids as string[]
      if (has(b, 'channel')) patch.channel = b.channel as InteractionChannel
      if (has(b, 'direction')) patch.direction = b.direction as InteractionDirection | null
      if (has(b, 'note')) patch.note = b.note as string | null
      if (has(b, 'occurred_at')) patch.occurred_at = b.occurred_at as string
      await updateInteraction(op.interactionId, patch)
      return null
    }
    case 'remove_created_circle': {
      if (!(await db.personCircles.where('sync_id').equals(op.circleId).first())) return 'the circle is already gone'
      if (await db.people.where('circle_sync_id').equals(op.circleId).count()) return 'people have been put in the circle since, so it was kept'
      await deleteCircle(op.circleId)
      return null
    }
    case 'restore_circle_fields': {
      if (!(await db.personCircles.where('sync_id').equals(op.circleId).first())) return 'the circle is gone'
      if (typeof op.before.name === 'string') await updateCircle(op.circleId, { name: op.before.name })
      if (op.orderBefore) {
        const now = (await sortedCircles()).map(c => c.sync_id)
        await writeCircleOrder([...op.orderBefore.filter(id => now.includes(id)), ...now.filter(id => !op.orderBefore!.includes(id))])
      }
      return null
    }
  }
}

export const PEOPLE_UNDO_KINDS: readonly PeopleUndoOp['kind'][] = [
  'remove_created_person', 'restore_person_fields', 'remove_created_date', 'restore_date_fields',
  'remove_interaction', 'restore_interaction_fields', 'remove_created_circle', 'restore_circle_fields',
]

/** Apply one People write. Refusals throw (Refusal); the caller turns them into typed errors. */
export async function handlePeopleWrite(method: string, p: Record<string, unknown>, ctx: WriteContext): Promise<Result | null> {
  switch (method) {
    case 'create_person': return createPersonWrite(p, ctx)
    case 'update_person': return updatePersonWrite(p, ctx)
    case 'add_person_date': return addDateWrite(p, ctx)
    case 'update_person_date': return updateDateWrite(p, ctx)
    case 'log_interaction': return logInteractionWrite(p, ctx)
    case 'update_interaction': return updateInteractionWrite(p, ctx)
    case 'create_circle': return createCircleWrite(p, ctx)
    case 'update_circle': return updateCircleWrite(p, ctx)
    default: return null
  }
}
