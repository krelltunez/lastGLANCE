// The pure, transport-agnostic intent handler.
//
// A single async function `handleIntent(action, payload, ctx)` that maps a SHORT
// action constant (`create`/`complete`/`open`/`query`) + payload onto a chore
// state change and returns a plain result object. It has NO Android knowledge:
// the Android/Tasker bridge (useAndroidIntentBridge) is one caller, but the
// handler could be driven by any transport. This mirrors dayGLANCE's
// handleIntent (see docs/tasker-intents-architecture.md §3.1), adapted to
// lastGLANCE's chore/cadence domain instead of tasks/due-dates.
//
// SKELETON MODE: every state-changing collaborator on `ctx` is optional. When a
// collaborator is absent the handler validates + normalizes the payload and
// returns success WITHOUT mutating anything — handy for tests and dry runs.
//
// IDEMPOTENCY: automation double-fires. CREATE dedupes by (name, category): a
// second identical CREATE returns the existing chore's id with a warning rather
// than adding a duplicate.

import { ACTIONS, CreateSchema, CompleteSchema, OpenSchema } from '@glance-apps/intents'
import { needsAttention, getFillRatio } from '@/utils/cadence'
import { LG_QUERY_VARS } from './androidIntents'

// The result object, serialized to JSON as the RESULT `result` extra. Plain keys
// (success/chore_id/error/warning) parse naturally in a Tasker JSON structure;
// QUERY adds the `%lg_*` count variables (see androidIntents.ts).
export interface IntentResult {
  success: boolean
  chore_id?: string
  error?: string
  warning?: string
  [k: string]: unknown
}

// A chore, reduced to what the handler needs. `elapsed_days` is the computed
// age since last completion (null = never completed); together with
// `target_cadence_days` it drives the "due"/"overdue" counts.
export interface IntentChore {
  id: number
  sync_id: string
  name: string
  category_id: number
  target_cadence_days: number | null
  elapsed_days: number | null
}

// Where OPEN routes once the app is foregrounded. Maps onto the app's existing
// deep-link events (see intentContext.ts).
export type OpenTarget = 'soon' | 'search' | 'add' | 'app'

export interface IntentContext {
  // Read the current chores (with computed elapsed_days). Required by COMPLETE
  // and QUERY; when absent those actions run in skeleton mode.
  listChores?: () => Promise<IntentChore[]>
  // Resolve a category by name to its id, creating it if missing. `null` (no
  // `project` in the CREATE payload) resolves the dedicated Inbox category.
  ensureCategory?: (name: string | null) => Promise<number>
  // Create a chore in a category; returns its new id + stable sync_id.
  createChore?: (input: { name: string; categoryId: number }) => Promise<{ id: number; sync_id: string }>
  // Count completions logged today (local calendar day). Used by QUERY.
  getDoneToday?: () => Promise<number>
  // Log a completion for a chore.
  logCompletion?: (choreId: number, completedAt?: string) => Promise<void>
  // Foreground + route the UI (OPEN).
  navigate?: (target: OpenTarget) => void
  // Fired after a COMPLETE succeeds, so the caller can emit an outbound NOTIFY
  // broadcast and refresh derived UI.
  onChoreCompleted?: (chore: { sync_id: string; name: string; completedAt: string }) => void
}

// Maps the OPEN payload's free-form `tab` onto a concrete UI target. Unknown /
// absent values just foreground the app.
function resolveOpenTarget(tab: string | undefined): OpenTarget {
  switch ((tab ?? '').toLowerCase()) {
    case 'soon':
    case 'due':
    case 'attention':
      return 'soon'
    case 'search':
    case 'find':
      return 'search'
    case 'add':
    case 'new':
    case 'create':
      return 'add'
    default:
      return 'app'
  }
}

// Finds the single chore a COMPLETE payload refers to by title. Exact
// case-insensitive match wins; failing that, a unique substring ("fuzzy") match
// is accepted with a warning. Returns a discriminated result so the caller can
// turn "none" / "ambiguous" into a helpful error.
type MatchResult =
  | { kind: 'one'; chore: IntentChore; fuzzy: boolean }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number }

export function matchChoreByTitle(chores: IntentChore[], title: string): MatchResult {
  const needle = title.trim().toLowerCase()
  const exact = chores.filter(c => c.name.trim().toLowerCase() === needle)
  if (exact.length === 1) return { kind: 'one', chore: exact[0], fuzzy: false }
  if (exact.length > 1) return { kind: 'ambiguous', count: exact.length }

  const partial = chores.filter(c => c.name.toLowerCase().includes(needle))
  if (partial.length === 1) return { kind: 'one', chore: partial[0], fuzzy: true }
  if (partial.length > 1) return { kind: 'ambiguous', count: partial.length }
  return { kind: 'none' }
}

async function handleCreate(payload: unknown, ctx: IntentContext): Promise<IntentResult> {
  const parsed = CreateSchema.safeParse(payload)
  if (!parsed.success) {
    return { success: false, error: `Invalid CREATE payload: ${parsed.error.issues[0]?.message ?? 'validation failed'}` }
  }
  const { title, project } = parsed.data

  // Skeleton mode: no way to persist — just echo the normalized title.
  if (!ctx.ensureCategory || !ctx.createChore) {
    return { success: true, title }
  }

  const categoryId = await ctx.ensureCategory(project ?? null)

  // Idempotency: a re-fired CREATE for the same (name, category) returns the
  // existing chore instead of duplicating it.
  if (ctx.listChores) {
    const existing = (await ctx.listChores()).find(
      c => c.category_id === categoryId && c.name.trim().toLowerCase() === title.trim().toLowerCase(),
    )
    if (existing) {
      return { success: true, chore_id: existing.sync_id, warning: 'Chore already exists; not duplicated' }
    }
  }

  const created = await ctx.createChore({ name: title, categoryId })
  return { success: true, chore_id: created.sync_id }
}

async function handleComplete(payload: unknown, ctx: IntentContext): Promise<IntentResult> {
  const parsed = CompleteSchema.safeParse(payload)
  if (!parsed.success) {
    return { success: false, error: `Invalid COMPLETE payload: ${parsed.error.issues[0]?.message ?? 'validation failed'}` }
  }
  const { title, completed_at } = parsed.data

  // Skeleton mode.
  if (!ctx.listChores || !ctx.logCompletion) {
    return { success: true, title }
  }

  const match = matchChoreByTitle(await ctx.listChores(), title)
  if (match.kind === 'none') return { success: false, error: `No chore matches "${title}"` }
  if (match.kind === 'ambiguous') {
    return { success: false, error: `"${title}" matches ${match.count} chores; be more specific` }
  }

  const { chore } = match
  const completedAt = completed_at ?? new Date().toISOString()
  await ctx.logCompletion(chore.id, completed_at)
  ctx.onChoreCompleted?.({ sync_id: chore.sync_id, name: chore.name, completedAt })

  const result: IntentResult = { success: true, chore_id: chore.sync_id }
  if (match.fuzzy) result.warning = `Fuzzy-matched "${title}" to "${chore.name}"`
  return result
}

function handleOpen(payload: unknown, ctx: IntentContext): IntentResult {
  const parsed = OpenSchema.safeParse(payload)
  if (!parsed.success) {
    return { success: false, error: `Invalid OPEN payload: ${parsed.error.issues[0]?.message ?? 'validation failed'}` }
  }
  const target = resolveOpenTarget(parsed.data.tab)
  ctx.navigate?.(target)
  return { success: true }
}

async function handleQuery(ctx: IntentContext): Promise<IntentResult> {
  // Skeleton mode: report zeros so the shape is stable for the sender.
  if (!ctx.listChores) {
    return {
      success: true,
      [LG_QUERY_VARS.COUNT_DUE]: 0,
      [LG_QUERY_VARS.COUNT_OVERDUE]: 0,
      [LG_QUERY_VARS.COUNT_DONE_TODAY]: 0,
      [LG_QUERY_VARS.COUNT_TOTAL]: 0,
    }
  }

  const chores = await ctx.listChores()
  let due = 0
  let overdue = 0
  for (const c of chores) {
    if (needsAttention(c.target_cadence_days, c.elapsed_days)) due++
    if (c.target_cadence_days !== null && c.elapsed_days !== null && getFillRatio(c.elapsed_days, c.target_cadence_days) >= 1) {
      overdue++
    }
  }

  return {
    success: true,
    [LG_QUERY_VARS.COUNT_DUE]: due,
    [LG_QUERY_VARS.COUNT_OVERDUE]: overdue,
    [LG_QUERY_VARS.COUNT_DONE_TODAY]: ctx.getDoneToday ? await ctx.getDoneToday() : 0,
    [LG_QUERY_VARS.COUNT_TOTAL]: chores.length,
  }
}

export async function handleIntent(
  action: string,
  payload: unknown,
  ctx: IntentContext = {},
): Promise<IntentResult> {
  switch (action) {
    case ACTIONS.CREATE:
      return handleCreate(payload, ctx)
    case ACTIONS.COMPLETE:
      return handleComplete(payload, ctx)
    case ACTIONS.OPEN:
      return handleOpen(payload, ctx)
    case ACTIONS.QUERY:
      return handleQuery(ctx)
    default:
      return { success: false, error: `Unknown action: ${action}` }
  }
}
