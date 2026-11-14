import dayjs, { type Dayjs } from 'dayjs'
import type { Category, Chore, CompletionEvent, User } from '@/types'
import type { Interaction, PersonCircle, PersonDate, PersonWithLastInteraction } from '@/people/types'
import { normalizeDirection } from '@/people/types'
import { getFillRatio, needsAttention } from '@/utils/cadence'
import { isInSeasonalWindow } from '@/utils/seasonal'
import { ownedByMe } from '@/utils/choreFilter'
import { cadenceRatio, dueDate, isSnoozed, reachOutList, upcomingDates, visibleToMe } from '@/people/home'

// The MCP read model (docs/mcp-and-stream-deck.md, 4.2): what the server's
// read tools answer, as a pure function of the data the page loaded
// (readData.ts). No Dexie, no React, no Electron: tested on fixtures.
//
// The main process asks over the request bridge (electron/mcpRendererBridge.ts)
// and validates, paginates and wraps; this resolves ids, filters and shapes.
// Every id it hands out is a sync id, the one that is the same on every
// device. Dates are the user's local calendar dates (YYYY-MM-DD); times are
// ISO instants as stored, which main writes in the user's local time on the
// way out (electron/mcpTimes.ts).
//
// People are scoped exactly as the People screens scope them (visibleToMe):
// with multi-user on, another household member's People never appear.
// Chores are household data: every chore is returned, with its assignees, as
// the app's "All" view shows them.

export interface McpReadData {
  now: Date
  categories: Category[]
  chores: Chore[]
  events: CompletionEvent[]
  users: User[]
  multiUserEnabled: boolean
  meUserSyncId: string | null
  /** Every person, archived included; scoped here, not by the loader. */
  people: PersonWithLastInteraction[]
  interactions: Interaction[]
  dates: PersonDate[]
  circles: PersonCircle[]
  showReciprocity: boolean
}

export interface McpRequest {
  method: string
  params?: unknown
}

export type McpError = { code: 'not_found' | 'validation' | 'internal' | 'not_connected'; message: string }
export type McpResult = { ok: true; data: unknown } | { ok: false; error: McpError }

export type ChoreState = 'overdue' | 'soon' | 'fresh' | 'none'
export const CHORE_STATES: readonly ChoreState[] = ['overdue', 'soon', 'fresh', 'none']

/** The read methods, as the bridge names them. People methods are served only under the People tier (main registers them). */
export const READ_METHODS = [
  'ping', 'overview', 'list_chores', 'get_chore', 'list_categories', 'activity', 'list_users',
  'list_people', 'get_person', 'upcoming_dates', 'list_circles', 'resolve_link',
] as const

export const DEFAULT_COMPLETIONS = 20
export const DEFAULT_INTERACTIONS = 20
export const MAX_HISTORY = 200
export const OVERVIEW_DUE_LIMIT = 50

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const ok = (data: unknown): McpResult => ({ ok: true, data })
const fail = (code: McpError['code'], message: string): McpResult => ({ ok: false, error: { code, message } })
const localDate = (iso: string | Dayjs): string => dayjs(iso).format('YYYY-MM-DD')
const round = (n: number, places = 2): number => Math.round(n * 10 ** places) / 10 ** places
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

// ── Chores ──────────────────────────────────────────────────────────────────

interface ChoreFacts {
  chore: Chore
  last: CompletionEvent | null
  count: number
  elapsedDays: number | null
}

interface Index {
  categories: Map<number, Category>
  categoryBySync: Map<string, Category>
  facts: ChoreFacts[]
  factBySync: Map<string, ChoreFacts>
  eventsByChore: Map<number, CompletionEvent[]>
  choreById: Map<number, Chore>
}

function buildIndex(data: McpReadData): Index {
  const categories = new Map(data.categories.map(c => [c.id, c]))
  const categoryBySync = new Map(data.categories.map(c => [c.sync_id, c]))
  const eventsByChore = new Map<number, CompletionEvent[]>()
  for (const e of data.events) {
    const list = eventsByChore.get(e.chore_id)
    if (list) list.push(e)
    else eventsByChore.set(e.chore_id, [e])
  }
  for (const list of eventsByChore.values()) list.sort((a, b) => b.completed_at.localeCompare(a.completed_at))
  const now = dayjs(data.now)
  const facts = data.chores.map((chore): ChoreFacts => {
    const events = eventsByChore.get(chore.id) ?? []
    const last = events[0] ?? null
    const elapsedDays = last ? round(now.diff(dayjs(last.completed_at), 'minute') / (60 * 24), 1) : null
    return { chore, last, count: events.length, elapsedDays }
  })
  return {
    categories,
    categoryBySync,
    facts,
    factBySync: new Map(facts.map(f => [f.chore.sync_id, f])),
    eventsByChore,
    choreById: new Map(data.chores.map(c => [c.id, c])),
  }
}

function choreState(target: number | null, elapsed: number | null): ChoreState {
  if (target == null || elapsed == null) return 'none'
  if (getFillRatio(elapsed, target) >= 1) return 'overdue'
  if (needsAttention(target, elapsed)) return 'soon'
  return 'fresh'
}

/** The category and its ancestors, root first. */
function categoryChain(idx: Index, categoryId: number): Category[] {
  const chain: Category[] = []
  const seen = new Set<number>()
  let c = idx.categories.get(categoryId)
  while (c && !seen.has(c.id)) {
    chain.unshift(c)
    seen.add(c.id)
    c = c.parent_category_id != null ? idx.categories.get(c.parent_category_id) : undefined
  }
  return chain
}

const categoryPath = (idx: Index, categoryId: number): string | null => {
  const chain = categoryChain(idx, categoryId)
  return chain.length ? chain.map(c => c.name).join(' › ') : null
}

/** Mine, as the app's filter reads it: the chore and its category are unassigned or include me. */
function isMine(idx: Index, chore: Chore, meId: string): boolean {
  const cat = idx.categories.get(chore.category_id)
  return ownedByMe(cat?.assigned_user_sync_ids ?? [], meId) && ownedByMe(chore.assigned_user_sync_ids ?? [], meId)
}

function choreSummary(idx: Index, f: ChoreFacts, now: Date) {
  const { chore } = f
  const target = chore.target_cadence_days
  const ratio = target != null && f.elapsedDays != null ? round(getFillRatio(f.elapsedDays, target)) : null
  return {
    id: chore.sync_id,
    name: chore.name,
    icon: chore.icon ?? null,
    category_id: idx.categories.get(chore.category_id)?.sync_id ?? null,
    category_path: categoryPath(idx, chore.category_id),
    state: choreState(target, f.elapsedDays),
    ratio,
    cadence_days: target,
    duration_minutes: chore.duration_minutes ?? null,
    last_completed_at: f.last?.completed_at ?? null,
    elapsed_days: f.elapsedDays,
    next_due: f.last && target != null ? localDate(dayjs(f.last.completed_at).add(target, 'day')) : null,
    pinned: !!chore.pinned,
    in_season: isInSeasonalWindow(chore, now),
    assignee_ids: chore.assigned_user_sync_ids ?? [],
  }
}

function completionItem(e: CompletionEvent) {
  return {
    id: e.sync_id,
    completed_at: e.completed_at,
    note: e.note,
    source: e.source,
    completed_by_user_id: e.completed_by_user_sync_id,
  }
}

const byDue = (a: { ratio: number | null; name: string }, b: { ratio: number | null; name: string }) =>
  (b.ratio ?? -1) - (a.ratio ?? -1) || a.name.localeCompare(b.name)

/** Soonest next due date first (overdue ones, being in the past, lead), then most overdue; none last. */
const byNextDue = (a: { next_due: string | null; ratio: number | null; name: string }, b: { next_due: string | null; ratio: number | null; name: string }) =>
  a.next_due === b.next_due ? byDue(a, b)
    : a.next_due === null ? 1 : b.next_due === null ? -1 : a.next_due.localeCompare(b.next_due)

function overview(data: McpReadData, idx: Index, params: Record<string, unknown>) {
  const today = localDate(dayjs(data.now))
  const inSeason = idx.facts.filter(f => isInSeasonalWindow(f.chore, data.now)).map(f => choreSummary(idx, f, data.now))
  const due = inSeason.filter(c => c.state === 'overdue' || c.state === 'soon').sort(byDue)
  const doneToday = data.events.filter(e => localDate(e.completed_at) === today).length
  const result: Record<string, unknown> = {
    counts: {
      overdue: due.filter(c => c.state === 'overdue').length,
      soon: due.filter(c => c.state === 'soon').length,
      done_today: doneToday,
      chores: data.chores.length,
    },
    due: due.slice(0, OVERVIEW_DUE_LIMIT),
    due_truncated: due.length > OVERVIEW_DUE_LIMIT,
    pinned: inSeason.filter(c => c.pinned).sort((a, b) => a.name.localeCompare(b.name)),
  }
  if (params.include_people === true) {
    const people = visiblePeople(data).filter(p => !p.archived)
    const now = dayjs(data.now)
    result.reach_out = reachOutList(people, data.dates, now, { showReciprocity: data.showReciprocity })
      .map(item => ({ ...personSummary(data, item.person), reason: reachOutReason(item.reason) }))
    result.coming_up = upcomingDates(data.dates, people, now).map(dateItem)
  }
  return result
}

function listChores(data: McpReadData, idx: Index, params: Record<string, unknown>): McpResult {
  let facts = idx.facts
  if (params.category_id !== undefined) {
    const cat = idx.categoryBySync.get(String(params.category_id))
    if (!cat) return fail('not_found', `No category with id ${JSON.stringify(params.category_id)}. List them with lastglance_list_categories.`)
    // A category includes its subcategories, as the app's own category view does.
    facts = facts.filter(f => categoryChain(idx, f.chore.category_id).some(c => c.id === cat.id))
  }
  if (params.assigned_to !== undefined) {
    const who = String(params.assigned_to)
    if (who === 'unassigned') {
      facts = facts.filter(f => (f.chore.assigned_user_sync_ids ?? []).length === 0)
    } else if (who === 'me') {
      if (!data.multiUserEnabled || !data.meUserSyncId) {
        return fail('validation', 'assigned_to "me" needs multi-user mode with "Me" set on this device. Use a user id from lastglance_list_users.')
      }
      facts = facts.filter(f => isMine(idx, f.chore, data.meUserSyncId!))
    } else {
      if (!data.users.some(u => u.sync_id === who)) return fail('not_found', `No user with id ${JSON.stringify(who)}. List them with lastglance_list_users.`)
      // Assigned to them: on the chore itself, or through the chore's own category.
      facts = facts.filter(f => (f.chore.assigned_user_sync_ids ?? []).includes(who)
        || (idx.categories.get(f.chore.category_id)?.assigned_user_sync_ids ?? []).includes(who))
    }
  }
  let items = facts.map(f => choreSummary(idx, f, data.now))
  // A window on next_due (local dates, both ends included). A chore with no
  // next due date (no cadence, or never done) has nothing to place in it, and a
  // seasonal chore out of season is not coming due: both are left out.
  const dueAfter = params.due_after === undefined ? null : String(params.due_after)
  const dueBefore = params.due_before === undefined ? null : String(params.due_before)
  if ((dueAfter !== null && !DATE_RE.test(dueAfter)) || (dueBefore !== null && !DATE_RE.test(dueBefore))) {
    return fail('validation', 'due_after and due_before must be YYYY-MM-DD local dates.')
  }
  if (dueAfter !== null || dueBefore !== null) {
    items = items.filter(c => c.next_due !== null && c.in_season
      && (dueAfter === null || c.next_due >= dueAfter) && (dueBefore === null || c.next_due <= dueBefore))
  }
  const state = params.state === undefined ? 'all' : String(params.state)
  if (state === 'due') items = items.filter(c => c.state === 'overdue' || c.state === 'soon')
  else if (state !== 'all') items = items.filter(c => c.state === state)
  if (typeof params.query === 'string' && params.query.trim()) {
    const words = fold(params.query).split(/\s+/).filter(Boolean)
    items = items.filter(c => {
      const hay = fold(`${c.name} ${c.category_path ?? ''}`)
      return words.every(w => hay.includes(w))
    })
  }
  items.sort(params.sort === 'next_due' ? byNextDue
    : state === 'all' ? (a, b) => (a.category_path ?? '').localeCompare(b.category_path ?? '') || a.name.localeCompare(b.name) : byDue)
  return ok({ items })
}

function getChore(data: McpReadData, idx: Index, params: Record<string, unknown>): McpResult {
  const f = idx.factBySync.get(String(params.chore_id))
  if (!f) return fail('not_found', `No chore with id ${JSON.stringify(params.chore_id)}. Find it with lastglance_list_chores.`)
  const limit = clampLimit(params.completions_limit, DEFAULT_COMPLETIONS)
  const events = idx.eventsByChore.get(f.chore.id) ?? []
  const c = f.chore
  return ok({
    ...choreSummary(idx, f, data.now),
    details: c.details,
    seasonal_start: c.seasonal_start,
    seasonal_end: c.seasonal_end,
    notify_when_overdue: !!c.notify_when_overdue,
    auto_schedule_to_dayglance: !!c.auto_schedule_to_dayglance,
    created_at: c.created_at,
    updated_at: c.updated_at,
    completions_total: f.count,
    completions: events.slice(0, limit).map(completionItem),
  })
}

function listCategories(data: McpReadData, idx: Index) {
  const counts = new Map<number, number>()
  for (const c of data.chores) counts.set(c.category_id, (counts.get(c.category_id) ?? 0) + 1)
  const items = [...data.categories]
    .map(c => ({
      id: c.sync_id,
      name: c.name,
      icon: c.icon ?? null,
      parent_id: c.parent_category_id != null ? idx.categories.get(c.parent_category_id)?.sync_id ?? null : null,
      path: categoryPath(idx, c.id),
      assignee_ids: c.assigned_user_sync_ids ?? [],
      chore_count: counts.get(c.id) ?? 0,
      sort_order: c.sort_order,
    }))
    .sort((a, b) => (a.path ?? '').localeCompare(b.path ?? ''))
  return { items }
}

function activity(data: McpReadData, idx: Index, params: Record<string, unknown>): McpResult {
  const from = String(params.from)
  const to = String(params.to)
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) return fail('validation', 'from and to must be YYYY-MM-DD local dates, from on or before to.')
  const byDay: Record<string, number> = {}
  const items: unknown[] = []
  const events = data.events
    .filter(e => { const d = localDate(e.completed_at); return d >= from && d <= to })
    .sort((a, b) => b.completed_at.localeCompare(a.completed_at))
  for (const e of events) {
    const d = localDate(e.completed_at)
    byDay[d] = (byDay[d] ?? 0) + 1
    const chore = idx.choreById.get(e.chore_id)
    if (!chore) continue
    items.push({
      ...completionItem(e),
      date: d,
      chore_id: chore.sync_id,
      chore_name: chore.name,
      category_path: categoryPath(idx, chore.category_id),
    })
  }
  return ok({ from, to, by_day: byDay, items })
}

function listUsers(data: McpReadData) {
  return {
    multi_user_enabled: data.multiUserEnabled,
    me_user_id: data.multiUserEnabled ? data.meUserSyncId : null,
    users: data.users.map(u => ({ id: u.sync_id, name: u.name })),
  }
}

// ── People ──────────────────────────────────────────────────────────────────

function visiblePeople(data: McpReadData): PersonWithLastInteraction[] {
  return visibleToMe(data.people, data.multiUserEnabled, data.meUserSyncId)
}

/** How much of the last contact's note a person summary carries; lastglance_get_person has every note in full. */
export const LAST_NOTE_CHARS = 280

// Each person's most recent contact, built once per request's data.
const lastContactCache = new WeakMap<Interaction[], Map<string, Interaction>>()
function lastContact(data: McpReadData, personSyncId: string): Interaction | undefined {
  let map = lastContactCache.get(data.interactions)
  if (!map) {
    map = new Map()
    for (const i of data.interactions) {
      for (const pid of i.person_sync_ids) {
        const prev = map.get(pid)
        if (!prev || i.occurred_at > prev.occurred_at) map.set(pid, i)
      }
    }
    lastContactCache.set(data.interactions, map)
  }
  return map.get(personSyncId)
}

/** The note on the person's most recent contact, shortened on a word to LAST_NOTE_CHARS, or null. */
function lastNote(data: McpReadData, personSyncId: string): string | null {
  const note = lastContact(data, personSyncId)?.note?.trim()
  if (!note) return null
  if (note.length <= LAST_NOTE_CHARS) return note
  const cut = note.slice(0, LAST_NOTE_CHARS - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > LAST_NOTE_CHARS * 0.8 ? cut.slice(0, space) : cut).trimEnd()}…`
}

function personSummary(data: McpReadData, p: PersonWithLastInteraction) {
  const ratio = cadenceRatio(p)
  const due = dueDate(p)
  const circle = p.circle_sync_id ? data.circles.find(c => c.sync_id === p.circle_sync_id) : undefined
  return {
    id: p.sync_id,
    name: p.name,
    nickname: p.nickname,
    circle_id: p.circle_sync_id,
    circle_name: circle?.name ?? null,
    cadence_days: p.target_cadence_days,
    preferred_channel: p.preferred_channel,
    last_interaction_at: p.last_interaction_at,
    last_channel: p.last_channel,
    last_interaction_note: lastNote(data, p.sync_id),
    elapsed_days: p.elapsed_days,
    ratio: ratio !== null ? round(ratio) : null,
    due_on: due ? localDate(due) : null,
    snoozed_until: isSnoozed(p, dayjs(data.now)) ? p.snoozed_until : null,
    archived: p.archived,
  }
}

function reachOutReason(reason: ReturnType<typeof reachOutList>[number]['reason']) {
  if (!reason) return null
  if (reason.kind === 'date') return { kind: 'date', date: dateItem(reason.upcoming) }
  if (reason.kind === 'streak') return { kind: 'streak', outbound_in_a_row: reason.count }
  return { kind: 'unreturned' }
}

function dateItem(u: ReturnType<typeof upcomingDates>[number]) {
  return {
    id: u.date.sync_id,
    person_id: u.person.sync_id,
    person_name: u.person.name,
    kind: u.date.kind,
    label: u.date.label,
    on: localDate(u.on),
    days_until: u.daysUntil,
    turning: u.turning,
  }
}

function interactionItem(i: Interaction) {
  return {
    id: i.sync_id,
    occurred_at: i.occurred_at,
    channel: i.channel,
    direction: normalizeDirection(i.direction),
    note: i.note,
    source: i.source,
    person_ids: i.person_sync_ids,
  }
}

function listPeople(data: McpReadData, params: Record<string, unknown>): McpResult {
  let people = visiblePeople(data)
  if (params.include_archived !== true) people = people.filter(p => !p.archived)
  if (params.circle_id !== undefined) {
    const id = String(params.circle_id)
    if (id !== 'none' && !data.circles.some(c => c.sync_id === id)) {
      return fail('not_found', `No circle with id ${JSON.stringify(id)}. List them with lastglance_list_circles.`)
    }
    people = people.filter(p => (id === 'none' ? p.circle_sync_id === null : p.circle_sync_id === id))
  }
  if (typeof params.query === 'string' && params.query.trim()) {
    const words = fold(params.query).split(/\s+/).filter(Boolean)
    people = people.filter(p => { const hay = fold(`${p.name} ${p.nickname ?? ''}`); return words.every(w => hay.includes(w)) })
  }
  const items = people.map(p => personSummary(data, p)).sort((a, b) => a.name.localeCompare(b.name))
  return ok({ items })
}

function getPerson(data: McpReadData, params: Record<string, unknown>): McpResult {
  const p = visiblePeople(data).find(x => x.sync_id === String(params.person_id))
  if (!p) return fail('not_found', `No person with id ${JSON.stringify(params.person_id)}. Find them with lastglance_list_people.`)
  const limit = clampLimit(params.interactions_limit, DEFAULT_INTERACTIONS)
  const now = dayjs(data.now)
  const interactions = data.interactions
    .filter(i => i.person_sync_ids.includes(p.sync_id))
    .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
  const upcoming = new Map(upcomingDates(data.dates, [p], now, 366).map(u => [u.date.sync_id, u]))
  const dates = data.dates.filter(d => d.person_sync_id === p.sync_id).map(d => {
    const u = upcoming.get(d.sync_id)
    return {
      id: d.sync_id,
      kind: d.kind,
      label: d.label,
      month: d.month,
      day: d.day,
      year: d.year,
      remind_days_before: d.remind_days_before,
      next_on: u ? localDate(u.on) : null,
      days_until: u ? u.daysUntil : null,
    }
  })
  return ok({
    ...personSummary(data, p),
    details: p.details,
    notify_when_overdue: !!p.notify_when_overdue,
    add_to_dayglance_when_overdue: !!p.add_to_dayglance_when_overdue,
    send_to_lifeglance: !!p.send_to_lifeglance,
    owner_user_id: p.owner_user_sync_id,
    created_at: p.created_at,
    updated_at: p.updated_at,
    reciprocity: { unreturned: p.reciprocity.unreturned, outbound_in_a_row: p.reciprocity.streak },
    dates,
    interactions_total: interactions.length,
    interactions: interactions.slice(0, limit).map(interactionItem),
  })
}

function listUpcoming(data: McpReadData, params: Record<string, unknown>): McpResult {
  const days = params.days === undefined ? 30 : Number(params.days)
  if (!Number.isInteger(days) || days < 0 || days > 366) return fail('validation', 'days must be a whole number from 0 to 366.')
  const people = visiblePeople(data).filter(p => !p.archived)
  return ok({ days, items: upcomingDates(data.dates, people, dayjs(data.now), days).map(dateItem) })
}

function listCircles(data: McpReadData) {
  const counts = new Map<string, number>()
  for (const p of visiblePeople(data)) if (!p.archived && p.circle_sync_id) counts.set(p.circle_sync_id, (counts.get(p.circle_sync_id) ?? 0) + 1)
  return {
    items: [...data.circles]
      .sort((a, b) => a.sort_order - b.sort_order)
      .map(c => ({ id: c.sync_id, name: c.name, icon: c.icon, people_count: counts.get(c.sync_id) ?? 0 })),
  }
}

// ── Links from dayGLANCE ────────────────────────────────────────────────────

/** A lastGLANCE date as dayGLANCE links it: `<date id>:<year>` (people/glanceIntents.ts). */
const DATE_LINK = /^(.+):(\d{4})$/

/**
 * What a dayGLANCE task's link.id is in lastGLANCE: a chore (a chore sent
 * there), a person (a reach-out) or a date (`<date id>:<year>`, a birthday or
 * date that year). dayGLANCE keeps nothing that says which, so this answers by
 * looking, as the completion it sends back is resolved (processNotifyEnvelope:
 * a chore, else a person). People and dates only under the People tier.
 */
function resolveLink(data: McpReadData, idx: Index, params: Record<string, unknown>): McpResult {
  const id = typeof params.id === 'string' ? params.id.trim() : ''
  if (!id) return fail('validation', 'id is required: a dayGLANCE task\'s link.id.')
  const chore = idx.factBySync.get(id)
  if (chore) return ok({ kind: 'chore', id, chore: choreSummary(idx, chore, data.now) })
  if (params.include_people !== true) {
    return fail('not_found', `No chore with id ${JSON.stringify(id)}. A person or a date is resolved only under the "Chores and People" tier.`)
  }
  const people = visiblePeople(data)
  const person = people.find(p => p.sync_id === id)
  if (person) return ok({ kind: 'person', id, person: personSummary(data, person) })
  const m = DATE_LINK.exec(id)
  const date = m ? data.dates.find(d => d.sync_id === m[1]) : undefined
  const owner = date ? people.find(p => p.sync_id === date.person_sync_id) : undefined
  if (date && owner) {
    return ok({
      kind: 'date',
      id,
      date: { id: date.sync_id, kind: date.kind, label: date.label, month: date.month, day: date.day, year: date.year },
      for_year: Number(m![2]),
      person: personSummary(data, owner),
    })
  }
  return fail('not_found', `Nothing in lastGLANCE has id ${JSON.stringify(id)}: no chore, person or date. It may have been deleted.`)
}

// ── Shared ──────────────────────────────────────────────────────────────────

/** Accent- and case-insensitive text for search, as the tray's search folds it. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

function clampLimit(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, MAX_HISTORY) : fallback
}

/** Answer one read request. Never throws for a bad request: that is a typed error. */
export function handleMcpRequest(data: McpReadData, request: McpRequest): McpResult {
  const params = obj(request.params)
  switch (request.method) {
    case 'ping': return ok({ ok: true })
    case 'overview': return ok(overview(data, buildIndex(data), params))
    case 'list_chores': return listChores(data, buildIndex(data), params)
    case 'get_chore': return getChore(data, buildIndex(data), params)
    case 'list_categories': return ok(listCategories(data, buildIndex(data)))
    case 'activity': return activity(data, buildIndex(data), params)
    case 'list_users': return ok(listUsers(data))
    case 'list_people': return listPeople(data, params)
    case 'get_person': return getPerson(data, params)
    case 'upcoming_dates': return listUpcoming(data, params)
    case 'list_circles': return ok(listCircles(data))
    case 'resolve_link': return resolveLink(data, buildIndex(data), params)
    default: return fail('validation', `Unknown read method ${JSON.stringify(request.method)}.`)
  }
}

/** Whether a method reads People, so the loader knows to load them. */
export function readsPeople(method: string): boolean {
  return method === 'list_people' || method === 'get_person' || method === 'upcoming_dates' || method === 'list_circles' || method === 'overview' || method === 'resolve_link'
}
