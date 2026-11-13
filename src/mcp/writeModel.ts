import dayjs from 'dayjs'
import { db } from '@/db/client'
import {
  createCategory, createChore, deleteCategory, deleteChore, deleteCompletion, ensureInboxCategory, logCompletion,
  reorderCategories, reorderChores, updateCategory, updateChore, updateCompletionNote,
} from '@/db/queries'
import { ICON_REGISTRY } from '@/icons/registry'
import type { Category, Chore } from '@/types'
import { handleMcpRequest } from './readModel'
import {
  bool, checkName, checkPosition, fail as failShared, has, obj, ok as okShared, placed, quote, Refusal, refuse,
  type UndoRecord as SharedUndoRecord, type WriteContext, type WriteResult as SharedWriteResult,
} from './writeShared'
import { loadMcpReadData } from './readData'
import { handlePeopleWrite, PEOPLE_UNDO_KINDS, PEOPLE_WRITE_METHODS, undoPeopleOp, type PeopleUndoOp } from './peopleWriteModel'

// The MCP write model, the page's half (docs/mcp-and-stream-deck.md, 4.5; the
// tools are electron/mcpWriteTools.ts, which validates the arguments' shape
// first). Each write goes through the same data-layer calls the app's own
// forms make, so it is marked dirty and pushed like a form's save, and it
// returns the entity as the read tools show it, plus the undo record: the
// before-state only the page holds, which main keeps in its session journal.
//
// The rules the forms apply, applied here too (the audit is in
// docs/mcp-tools-reference.md, "What the tools change"):
//  - a new chore takes its category's icon and assignees when the call names
//    none; a completion is the device's Me, now unless backdated, never in the
//    future; a completion's note is the only thing about it that changes;
//  - nothing is ever deleted, except by an undo of the write that created it,
//    and an undo never takes data the user added since with it.
//
// Creates take the id main derives from the idempotency key: a create that
// finds its id already stored is a replay and changes nothing.

export type UndoOp = ChoreUndoOp | PeopleUndoOp

export type ChoreUndoOp =
  | { kind: 'remove_completion'; completionId: string; choreId: string }
  | { kind: 'restore_completion_note'; completionId: string; choreId: string; before: string | null }
  | { kind: 'remove_created_chore'; choreId: string }
  | { kind: 'restore_chore_fields'; choreId: string; before: Record<string, unknown>; orderBefore?: string[] }
  | { kind: 'remove_created_category'; categoryId: string }
  | { kind: 'restore_category_fields'; categoryId: string; before: Record<string, unknown>; liftedChildren?: string[]; orderBefore?: string[] }

export type UndoRecord = SharedUndoRecord<UndoOp>
export type WriteResult = SharedWriteResult<UndoOp>
export type { WriteContext }

export const WRITE_METHODS = [
  'complete_chore', 'update_completion', 'create_chore', 'update_chore', 'create_category', 'update_category',
  ...PEOPLE_WRITE_METHODS, 'undo_mcp_writes',
] as const

export const CHORE_DETAILS_MAX = 2000

const ok = (data: Record<string, unknown>, undo?: UndoRecord): WriteResult => okShared<UndoOp>(data, undo)
const fail = failShared
const SEASON_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

// ── Lookups ─────────────────────────────────────────────────────────────────

async function choreBySync(id: unknown): Promise<Chore> {
  const c = typeof id === 'string' ? await db.chores.where('sync_id').equals(id).first() : undefined
  return c ?? refuse('not_found', `No chore with id ${JSON.stringify(id)}. Find it with lastglance_list_chores.`)
}

async function categoryBySync(id: unknown): Promise<Category> {
  const c = typeof id === 'string' ? await db.categories.where('sync_id').equals(id).first() : undefined
  return c ?? refuse('not_found', `No category with id ${JSON.stringify(id)}. List them with lastglance_list_categories.`)
}

async function checkUsers(ids: unknown): Promise<string[]> {
  if (!Array.isArray(ids) || ids.some(i => typeof i !== 'string')) refuse('validation', 'assignee_ids must be a list of user ids.')
  const known = new Set((await db.users.toArray()).map(u => u.sync_id))
  const unknown = (ids as string[]).filter(i => !known.has(i))
  if (unknown.length) refuse('not_found', `No user with id ${JSON.stringify(unknown[0])}. List them with lastglance_list_users.`)
  return [...new Set(ids as string[])]
}

function checkIcon(icon: unknown): string | undefined {
  if (icon === null) return undefined
  if (typeof icon !== 'string' || !ICON_REGISTRY[icon]) refuse('validation', `icon must be a Lucide icon name the app knows (as in lastglance_get_chore), got ${JSON.stringify(icon)}.`)
  return icon as string
}

function checkSeason(v: unknown): { seasonal_start: string | null; seasonal_end: string | null } {
  if (v === null) return { seasonal_start: null, seasonal_end: null }
  const s = obj(v)
  const valid = (x: unknown) => typeof x === 'string' && SEASON_RE.test(x) && Number(x.slice(3)) <= DAYS_IN_MONTH[Number(x.slice(0, 2)) - 1]
  if (!valid(s.start) || !valid(s.end)) refuse('validation', 'season needs start and end as real MM-DD days (an end before the start wraps the new year), or null for all year.')
  return { seasonal_start: s.start as string, seasonal_end: s.end as string }
}

/** A cadence in whole days, at least 1, or null for none. */
function checkCadence(v: unknown): number | null {
  if (v === null) return null
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 36500) refuse('validation', 'cadence_days must be a whole number of days, 1 or more, or null for no cadence.')
  return v as number
}

function checkDetails(v: unknown): string | null {
  if (v === null) return null
  if (typeof v !== 'string') refuse('validation', 'details must be text, or null to clear them.')
  const t = (v as string).trim()
  if (t.length > CHORE_DETAILS_MAX) refuse('validation', `details are at most ${CHORE_DETAILS_MAX} characters.`)
  return t || null
}


// ── Results, as the read tools show them ────────────────────────────────────

async function choreResult(syncId: string): Promise<Record<string, unknown>> {
  const r = handleMcpRequest(await loadMcpReadData(false), { method: 'get_chore', params: { chore_id: syncId, completions_limit: 5 } })
  return r.ok ? r.data as Record<string, unknown> : { id: syncId }
}

async function categoryResult(syncId: string): Promise<Record<string, unknown>> {
  const r = handleMcpRequest(await loadMcpReadData(false), { method: 'list_categories' })
  const items = r.ok ? (r.data as { items: { id: string }[] }).items : []
  return items.find(c => c.id === syncId) ?? { id: syncId }
}

// ── Order ───────────────────────────────────────────────────────────────────

const sortedChores = async (categoryId: number) => (await db.chores.where('category_id').equals(categoryId).toArray())
  .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
const siblingCategories = async (parentId: number | undefined) => (await db.categories.toArray())
  .filter(c => (c.parent_category_id ?? undefined) === (parentId ?? undefined))
  .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)

// ── Chores and completions ──────────────────────────────────────────────────

async function completeChore(p: Record<string, unknown>, ctx: WriteContext): Promise<WriteResult> {
  const chore = await choreBySync(p.chore_id)
  const newId = String(p.new_id)
  if (await db.completionEvents.where('sync_id').equals(newId).first()) return ok({ chore: await choreResult(chore.sync_id), replayed: true })
  let completedAt: string | undefined
  if (p.completed_at !== undefined) {
    const at = dayjs(String(p.completed_at))
    if (!at.isValid()) refuse('validation', 'completed_at must be an ISO 8601 time.')
    if (at.isAfter(dayjs(ctx.now()).add(1, 'minute'))) refuse('validation', 'completed_at cannot be in the future, as in the app.')
    completedAt = at.toISOString()
  }
  let note: string | undefined
  if (p.note !== undefined && p.note !== null) {
    if (typeof p.note !== 'string') refuse('validation', 'note must be text.')
    note = (p.note as string).trim() || undefined
  }
  await logCompletion(chore.id, { completedAt, note, completedByUserSyncId: ctx.meUserSyncId, syncId: newId })
  ctx.activity(`Completed "${chore.name}" via MCP`)
  ctx.changed()
  const event = await db.completionEvents.where('sync_id').equals(newId).first()
  return ok(
    { completion: { id: newId, completed_at: event?.completed_at ?? completedAt, note: event?.note ?? null }, chore: await choreResult(chore.sync_id) },
    { summary: `Marked ${quote(chore.name)} done`, op: { kind: 'remove_completion', completionId: newId, choreId: chore.sync_id } },
  )
}

async function updateCompletion(p: Record<string, unknown>, ctx: WriteContext): Promise<WriteResult> {
  const event = typeof p.completion_id === 'string' ? await db.completionEvents.where('sync_id').equals(p.completion_id).first() : undefined
  if (!event) return fail('not_found', `No completion with id ${JSON.stringify(p.completion_id)}. Completions are listed by lastglance_get_chore.`)
  if (p.note !== null && typeof p.note !== 'string') return fail('validation', 'note must be text, or null to clear it.')
  const chore = await db.chores.get(event.chore_id)
  const note = typeof p.note === 'string' ? p.note.trim() || null : null
  await updateCompletionNote(event.id, note)
  ctx.changed()
  return ok(
    { completion: { id: event.sync_id, completed_at: event.completed_at, note }, chore: chore ? await choreResult(chore.sync_id) : null },
    { summary: `Changed the note on ${quote(chore?.name ?? 'a completion')}`, op: { kind: 'restore_completion_note', completionId: event.sync_id, choreId: chore?.sync_id ?? '', before: event.note } },
  )
}

async function createChoreWrite(p: Record<string, unknown>, ctx: WriteContext): Promise<WriteResult> {
  const newId = String(p.new_id)
  if (await db.chores.where('sync_id').equals(newId).first()) return ok({ chore: await choreResult(newId), replayed: true })
  const name = checkName(p.name)
  const category = p.category_id !== undefined ? await categoryBySync(p.category_id) : (await ensureInboxCategory()).category
  // The intents path's dedupe: the same name in the same category is the chore already there.
  const same = (await db.chores.where('category_id').equals(category.id).toArray()).find(c => c.name.trim().toLowerCase() === name.toLowerCase())
  if (same) return ok({ chore: await choreResult(same.sync_id), already_existed: true })
  const season = p.season !== undefined ? checkSeason(p.season) : { seasonal_start: null, seasonal_end: null }
  const icon = p.icon !== undefined ? checkIcon(p.icon) : category.icon || undefined
  const assignees = p.assignee_ids !== undefined ? await checkUsers(p.assignee_ids) : [...(category.assigned_user_sync_ids ?? [])]
  const position = p.position !== undefined ? checkPosition(p.position) : undefined
  const id = await createChore({
    sync_id: newId,
    name,
    category_id: category.id,
    target_cadence_days: p.cadence_days !== undefined ? checkCadence(p.cadence_days) : null,
    notify_when_overdue: p.notify_when_overdue !== undefined ? bool(p.notify_when_overdue, 'notify_when_overdue') : false,
    auto_schedule_to_dayglance: p.auto_schedule_to_dayglance !== undefined ? bool(p.auto_schedule_to_dayglance, 'auto_schedule_to_dayglance') : false,
    preferred_schedule_behavior: null,
    details: p.details !== undefined ? checkDetails(p.details) : null,
    pinned: p.pinned !== undefined ? bool(p.pinned, 'pinned') : false,
    assigned_user_sync_ids: assignees,
    ...season,
    ...(icon && { icon }),
  })
  if (position !== undefined) await reorderChores(placed(await sortedChores(category.id), id, position))
  ctx.activity(`Created "${name}" via MCP`)
  ctx.changed()
  return ok({ chore: await choreResult(newId) }, { summary: `Created ${quote(name)}`, op: { kind: 'remove_created_chore', choreId: newId } })
}

/** The chore's editable fields, under the tools' names, for an undo. */
async function choreFields(c: Chore): Promise<Record<string, unknown>> {
  const cat = await db.categories.get(c.category_id)
  return {
    name: c.name,
    category_id: cat?.sync_id ?? null,
    cadence_days: c.target_cadence_days,
    icon: c.icon ?? null,
    details: c.details,
    pinned: !!c.pinned,
    notify_when_overdue: !!c.notify_when_overdue,
    auto_schedule_to_dayglance: !!c.auto_schedule_to_dayglance,
    season: c.seasonal_start && c.seasonal_end ? { start: c.seasonal_start, end: c.seasonal_end } : null,
    assignee_ids: c.assigned_user_sync_ids ?? [],
  }
}

const CHORE_FIELDS = ['name', 'category_id', 'cadence_days', 'icon', 'details', 'pinned', 'notify_when_overdue', 'auto_schedule_to_dayglance', 'season', 'assignee_ids'] as const

/** Apply the tools' chore fields through updateChore, as the form saves them. */
async function applyChoreFields(chore: Chore, f: Record<string, unknown>): Promise<void> {
  const patch: Partial<Chore> & { icon?: string } = {}
  if (has(f, 'name')) patch.name = checkName(f.name)
  if (has(f, 'category_id')) patch.category_id = (await categoryBySync(f.category_id)).id
  if (has(f, 'cadence_days')) patch.target_cadence_days = checkCadence(f.cadence_days)
  if (has(f, 'icon')) patch.icon = checkIcon(f.icon)
  if (has(f, 'details')) patch.details = checkDetails(f.details)
  if (has(f, 'pinned')) patch.pinned = bool(f.pinned, 'pinned')
  if (has(f, 'notify_when_overdue')) patch.notify_when_overdue = bool(f.notify_when_overdue, 'notify_when_overdue')
  if (has(f, 'auto_schedule_to_dayglance')) patch.auto_schedule_to_dayglance = bool(f.auto_schedule_to_dayglance, 'auto_schedule_to_dayglance')
  if (has(f, 'season')) Object.assign(patch, checkSeason(f.season))
  if (has(f, 'assignee_ids')) patch.assigned_user_sync_ids = await checkUsers(f.assignee_ids)
  await updateChore(chore.id, patch)
}

async function updateChoreWrite(p: Record<string, unknown>, ctx: WriteContext): Promise<WriteResult> {
  const chore = await choreBySync(p.chore_id)
  const fields = obj(p.fields)
  const touched = CHORE_FIELDS.filter(k => has(fields, k))
  const position = p.position !== undefined ? checkPosition(p.position) : undefined
  if (touched.length === 0 && position === undefined) return fail('validation', 'Name at least one field to change, or a position.')
  const all = await choreFields(chore)
  const before = Object.fromEntries(touched.map(k => [k, all[k]]))
  const orderBefore = position !== undefined || has(fields, 'category_id') ? (await sortedChores(chore.category_id)).map(c => c.sync_id) : undefined
  await applyChoreFields(chore, fields)
  if (position !== undefined) {
    const now = (await db.chores.get(chore.id))!
    await reorderChores(placed(await sortedChores(now.category_id), chore.id, position))
  }
  ctx.changed()
  const name = typeof fields.name === 'string' ? fields.name.trim() : chore.name
  return ok({ chore: await choreResult(chore.sync_id) }, {
    summary: `Edited ${quote(name)}`,
    op: { kind: 'restore_chore_fields', choreId: chore.sync_id, before, ...(orderBefore && { orderBefore }) },
  })
}

// ── Categories ──────────────────────────────────────────────────────────────

/** A parent must be a top-level category, other than the category itself: the app draws two levels. */
async function checkParent(parentId: unknown, self?: Category): Promise<Category | null> {
  if (parentId === null) return null
  const parent = await categoryBySync(parentId)
  if (parent.parent_category_id != null) refuse('validation', `${quote(parent.name)} is a subcategory; a parent must be a top-level category.`)
  if (self && parent.id === self.id) refuse('validation', 'A category cannot be its own parent.')
  return parent
}

async function createCategoryWrite(p: Record<string, unknown>, ctx: WriteContext): Promise<WriteResult> {
  const newId = String(p.new_id)
  if (await db.categories.where('sync_id').equals(newId).first()) return ok({ category: await categoryResult(newId), replayed: true })
  const name = checkName(p.name)
  const parent = p.parent_id !== undefined ? await checkParent(p.parent_id) : null
  // As the form does: a new subcategory takes its parent's icon; assignees are not inherited.
  const icon = p.icon !== undefined ? checkIcon(p.icon) : parent?.icon || undefined
  const assignees = p.assignee_ids !== undefined ? await checkUsers(p.assignee_ids) : []
  const position = p.position !== undefined ? checkPosition(p.position) : undefined
  const id = await createCategory(name, undefined, icon, parent?.id, assignees, newId)
  if (position !== undefined) await reorderCategories(placed(await siblingCategories(parent?.id), id, position))
  ctx.changed()
  return ok({ category: await categoryResult(newId) }, { summary: `Created the category ${quote(name)}`, op: { kind: 'remove_created_category', categoryId: newId } })
}

const CATEGORY_FIELDS = ['name', 'icon', 'parent_id', 'assignee_ids'] as const

async function categoryFields(c: Category): Promise<Record<string, unknown>> {
  const parent = c.parent_category_id != null ? await db.categories.get(c.parent_category_id) : undefined
  return { name: c.name, icon: c.icon || null, parent_id: parent?.sync_id ?? null, assignee_ids: c.assigned_user_sync_ids ?? [] }
}

async function applyCategoryFields(c: Category, f: Record<string, unknown>): Promise<void> {
  const patch: Parameters<typeof updateCategory>[1] = {}
  if (has(f, 'name')) patch.name = checkName(f.name)
  if (has(f, 'icon')) patch.icon = checkIcon(f.icon)
  if (has(f, 'assignee_ids')) patch.assigned_user_sync_ids = await checkUsers(f.assignee_ids)
  if (has(f, 'parent_id')) patch.parent_category_id = (await checkParent(f.parent_id, c))?.id ?? null
  await updateCategory(c.id, patch)
}

async function updateCategoryWrite(p: Record<string, unknown>, ctx: WriteContext): Promise<WriteResult> {
  const category = await categoryBySync(p.category_id)
  const fields = obj(p.fields)
  const touched = CATEGORY_FIELDS.filter(k => has(fields, k))
  const position = p.position !== undefined ? checkPosition(p.position) : undefined
  if (touched.length === 0 && position === undefined) return fail('validation', 'Name at least one field to change, or a position.')
  const all = await categoryFields(category)
  const before = Object.fromEntries(touched.map(k => [k, all[k]]))
  // Nesting a category lifts its own subcategories to the new parent (updateCategory, #191): the undo puts them back.
  const liftedChildren = has(fields, 'parent_id') && fields.parent_id !== null
    ? (await db.categories.where('parent_category_id').equals(category.id).toArray()).map(c => c.sync_id)
    : []
  const orderBefore = position !== undefined || has(fields, 'parent_id') ? (await siblingCategories(category.parent_category_id)).map(c => c.sync_id) : undefined
  await applyCategoryFields(category, fields)
  if (position !== undefined) {
    const now = (await db.categories.get(category.id))!
    await reorderCategories(placed(await siblingCategories(now.parent_category_id), category.id, position))
  }
  ctx.changed()
  const name = typeof fields.name === 'string' ? fields.name.trim() : category.name
  return ok({ category: await categoryResult(category.sync_id) }, {
    summary: `Edited the category ${quote(name)}`,
    op: { kind: 'restore_category_fields', categoryId: category.sync_id, before, ...(liftedChildren.length && { liftedChildren }), ...(orderBefore && { orderBefore }) },
  })
}

// ── Undo ────────────────────────────────────────────────────────────────────

async function restoreOrder<T extends { id: number; sync_id: string }>(rows: T[], orderBefore: string[], reorder: (ids: number[]) => Promise<void>) {
  const bySync = new Map(rows.map(r => [r.sync_id, r.id]))
  const known = orderBefore.map(s => bySync.get(s)).filter((x): x is number => x !== undefined)
  const added = rows.map(r => r.id).filter(id => !known.includes(id))
  await reorder([...known, ...added])
}

/** Reverse one op. Returns why it was skipped, or null when it was undone. */
async function undoOne(anyOp: UndoOp, ctx: WriteContext): Promise<string | null> {
  if ((PEOPLE_UNDO_KINDS as readonly string[]).includes(anyOp.kind)) return undoPeopleOp(anyOp as PeopleUndoOp, ctx)
  const op = anyOp as ChoreUndoOp
  switch (op.kind) {
    case 'remove_completion': {
      const e = await db.completionEvents.where('sync_id').equals(op.completionId).first()
      if (!e) return 'the completion is already gone'
      await deleteCompletion(e.id)
      return null
    }
    case 'restore_completion_note': {
      const e = await db.completionEvents.where('sync_id').equals(op.completionId).first()
      if (!e) return 'the completion is gone'
      await updateCompletionNote(e.id, op.before)
      return null
    }
    case 'remove_created_chore': {
      const c = await db.chores.where('sync_id').equals(op.choreId).first()
      if (!c) return 'the chore is already gone'
      if (await db.completionEvents.where('chore_id').equals(c.id).count()) return 'the chore has been done since, so it was kept'
      await deleteChore(c.id)
      return null
    }
    case 'restore_chore_fields': {
      const c = await db.chores.where('sync_id').equals(op.choreId).first()
      if (!c) return 'the chore is gone'
      if (has(op.before, 'category_id') && op.before.category_id && !(await db.categories.where('sync_id').equals(String(op.before.category_id)).first())) {
        return 'its old category is gone'
      }
      await applyChoreFields(c, op.before)
      if (op.orderBefore) {
        const now = (await db.chores.get(c.id))!
        await restoreOrder(await sortedChores(now.category_id), op.orderBefore, reorderChores)
      }
      return null
    }
    case 'remove_created_category': {
      const c = await db.categories.where('sync_id').equals(op.categoryId).first()
      if (!c) return 'the category is already gone'
      if (await db.chores.where('category_id').equals(c.id).count()) return 'the category has chores in it now, so it was kept'
      if (await db.categories.where('parent_category_id').equals(c.id).count()) return 'the category has subcategories now, so it was kept'
      await deleteCategory(c.id)
      return null
    }
    case 'restore_category_fields': {
      const c = await db.categories.where('sync_id').equals(op.categoryId).first()
      if (!c) return 'the category is gone'
      if (has(op.before, 'parent_id') && op.before.parent_id && !(await db.categories.where('sync_id').equals(String(op.before.parent_id)).first())) {
        return 'its old parent is gone'
      }
      await applyCategoryFields(c, op.before)
      for (const childId of op.liftedChildren ?? []) {
        const child = await db.categories.where('sync_id').equals(childId).first()
        if (child) await updateCategory(child.id, { parent_category_id: c.id })
      }
      if (op.orderBefore) {
        const now = (await db.categories.get(c.id))!
        await restoreOrder(await siblingCategories(now.parent_category_id), op.orderBefore, reorderCategories)
      }
      return null
    }
  }
}

/** Undo ops newest first, as main sends them; a skipped op is reported, never forced. */
async function undoWrites(p: Record<string, unknown>, ctx: WriteContext): Promise<WriteResult> {
  if (!Array.isArray(p.ops)) return fail('validation', 'ops must be a list.')
  let undone = 0
  const skipped: { kind: string; reason: string }[] = []
  for (const op of p.ops as UndoOp[]) {
    try {
      const reason = await undoOne(op, ctx)
      if (reason) skipped.push({ kind: op.kind, reason })
      else undone++
    } catch (e) {
      skipped.push({ kind: String(obj(op).kind), reason: e instanceof Error ? e.message : 'failed' })
    }
  }
  ctx.changed()
  return ok({ undone, skipped })
}

/** Apply one write. Never throws for a bad request: that is a typed error. */
export async function handleMcpWrite(method: string, params: unknown, ctx: WriteContext): Promise<WriteResult> {
  const p = obj(params)
  try {
    switch (method) {
      case 'complete_chore': return await completeChore(p, ctx)
      case 'update_completion': return await updateCompletion(p, ctx)
      case 'create_chore': return await createChoreWrite(p, ctx)
      case 'update_chore': return await updateChoreWrite(p, ctx)
      case 'create_category': return await createCategoryWrite(p, ctx)
      case 'update_category': return await updateCategoryWrite(p, ctx)
      case 'undo_mcp_writes': return await undoWrites(p, ctx)
      default: return (await handlePeopleWrite(method, p, ctx)) ?? fail('validation', `Unknown write method ${JSON.stringify(method)}.`)
    }
  } catch (e) {
    if (e instanceof Refusal) return fail(e.code, e.message)
    throw e
  }
}

export function isWriteMethod(method: string): boolean {
  return (WRITE_METHODS as readonly string[]).includes(method)
}
