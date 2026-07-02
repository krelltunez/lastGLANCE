import { describe, it, expect, vi } from 'vitest'
import { ACTIONS } from '@glance-apps/intents'
import { handleIntent, matchChoreByTitle, type IntentChore, type IntentContext } from './handleIntent'
import { LG_QUERY_VARS } from './androidIntents'

const CHORE_A: IntentChore = {
  id: 1,
  sync_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  name: 'Mop kitchen',
  category_id: 10,
  target_cadence_days: 14,
  elapsed_days: 20, // ratio 1.43 → overdue (and due)
}
const CHORE_B: IntentChore = {
  id: 2,
  sync_id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  name: 'Clean bathrooms',
  category_id: 10,
  target_cadence_days: 7,
  elapsed_days: 6, // ratio 0.86 → due (needs attention) but not overdue
}
const CHORE_C: IntentChore = {
  id: 3,
  sync_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  name: 'Wash car',
  category_id: 20,
  target_cadence_days: 30,
  elapsed_days: 3, // ratio 0.1 → neither
}

function fullContext(overrides: Partial<IntentContext> = {}): IntentContext {
  return {
    listChores: vi.fn(async () => [CHORE_A, CHORE_B, CHORE_C]),
    ensureCategory: vi.fn(async () => 10),
    createChore: vi.fn(async () => ({ id: 99, sync_id: 'new-sync-id' })),
    getDoneToday: vi.fn(async () => 4),
    logCompletion: vi.fn(async () => {}),
    navigate: vi.fn(),
    onChoreCompleted: vi.fn(),
    ...overrides,
  }
}

describe('handleIntent – CREATE', () => {
  it('creates a chore, mapping project → category', async () => {
    const ctx = fullContext({
      listChores: vi.fn(async () => []),
      ensureCategory: vi.fn(async () => 42),
    })
    const res = await handleIntent(ACTIONS.CREATE, { title: 'Descale kettle', project: 'Kitchen' }, ctx)
    expect(res.success).toBe(true)
    expect(res.chore_id).toBe('new-sync-id')
    expect(ctx.ensureCategory).toHaveBeenCalledWith('Kitchen')
    expect(ctx.createChore).toHaveBeenCalledWith({ name: 'Descale kettle', categoryId: 42 })
  })

  it('resolves the Inbox (null) when no project is given', async () => {
    const ctx = fullContext({ listChores: vi.fn(async () => []) })
    await handleIntent(ACTIONS.CREATE, { title: 'Buy stamps' }, ctx)
    expect(ctx.ensureCategory).toHaveBeenCalledWith(null)
  })

  it('is idempotent: a duplicate (name, category) returns the existing chore, no create', async () => {
    const ctx = fullContext()
    const res = await handleIntent(ACTIONS.CREATE, { title: 'Mop kitchen', project: 'Home' }, ctx)
    expect(res.success).toBe(true)
    expect(res.chore_id).toBe(CHORE_A.sync_id)
    expect(res.warning).toMatch(/already exists/i)
    expect(ctx.createChore).not.toHaveBeenCalled()
  })

  it('rejects a payload with no title', async () => {
    const res = await handleIntent(ACTIONS.CREATE, { project: 'Home' }, fullContext())
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Invalid CREATE/)
  })

  it('skeleton mode echoes the title without mutating', async () => {
    const res = await handleIntent(ACTIONS.CREATE, { title: 'Dust shelves' }, {})
    expect(res).toEqual({ success: true, title: 'Dust shelves' })
  })
})

describe('handleIntent – COMPLETE', () => {
  it('logs a completion for an exact title match', async () => {
    const ctx = fullContext()
    const res = await handleIntent(ACTIONS.COMPLETE, { title: 'Wash car' }, ctx)
    expect(res.success).toBe(true)
    expect(res.chore_id).toBe(CHORE_C.sync_id)
    expect(res.warning).toBeUndefined()
    expect(ctx.logCompletion).toHaveBeenCalledWith(CHORE_C.id, undefined)
    expect(ctx.onChoreCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ sync_id: CHORE_C.sync_id, name: 'Wash car' }),
    )
  })

  it('passes completed_at through to logCompletion', async () => {
    const ctx = fullContext()
    const when = '2026-06-01T09:30:00.000Z'
    await handleIntent(ACTIONS.COMPLETE, { title: 'Wash car', completed_at: when }, ctx)
    expect(ctx.logCompletion).toHaveBeenCalledWith(CHORE_C.id, when)
  })

  it('fuzzy-matches a unique substring and warns', async () => {
    const ctx = fullContext()
    const res = await handleIntent(ACTIONS.COMPLETE, { title: 'car' }, ctx)
    expect(res.success).toBe(true)
    expect(res.chore_id).toBe(CHORE_C.sync_id)
    expect(res.warning).toMatch(/Fuzzy-matched/)
  })

  it('errors when no chore matches', async () => {
    const res = await handleIntent(ACTIONS.COMPLETE, { title: 'Feed the dragon' }, fullContext())
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/No chore matches/)
  })

  it('errors when a fuzzy title is ambiguous', async () => {
    // "clean" is a substring of two chores → ambiguous, no exact match.
    const ctx = fullContext({
      listChores: vi.fn(async () => [
        { ...CHORE_B, id: 2, sync_id: 'b1', name: 'Clean bathrooms' },
        { ...CHORE_B, id: 3, sync_id: 'b2', name: 'Clean windows' },
      ]),
    })
    const res = await handleIntent(ACTIONS.COMPLETE, { title: 'clean' }, ctx)
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/matches 2 chores/)
    expect(ctx.logCompletion).not.toHaveBeenCalled()
  })

  it('skeleton mode echoes the title without mutating', async () => {
    const res = await handleIntent(ACTIONS.COMPLETE, { title: 'Wash car' }, {})
    expect(res).toEqual({ success: true, title: 'Wash car' })
  })
})

describe('handleIntent – OPEN', () => {
  it.each([
    ['soon', 'soon'],
    ['due', 'soon'],
    ['search', 'search'],
    ['add', 'add'],
    ['whatever', 'app'],
    [undefined, 'app'],
  ])('routes tab=%s → %s', async (tab, expected) => {
    const ctx = fullContext()
    const res = await handleIntent(ACTIONS.OPEN, tab === undefined ? {} : { tab }, ctx)
    expect(res.success).toBe(true)
    expect(ctx.navigate).toHaveBeenCalledWith(expected)
  })
})

describe('handleIntent – QUERY', () => {
  it('returns %lg_ counts computed from cadence state', async () => {
    const res = await handleIntent(ACTIONS.QUERY, {}, fullContext())
    expect(res.success).toBe(true)
    expect(res[LG_QUERY_VARS.COUNT_DUE]).toBe(2) // CHORE_A (overdue) + CHORE_B (attention)
    expect(res[LG_QUERY_VARS.COUNT_OVERDUE]).toBe(1) // CHORE_A only
    expect(res[LG_QUERY_VARS.COUNT_DONE_TODAY]).toBe(4)
    expect(res[LG_QUERY_VARS.COUNT_TOTAL]).toBe(3)
  })

  it('skeleton mode reports zeros', async () => {
    const res = await handleIntent(ACTIONS.QUERY, {}, {})
    expect(res.success).toBe(true)
    expect(res[LG_QUERY_VARS.COUNT_TOTAL]).toBe(0)
  })
})

describe('handleIntent – unknown action', () => {
  it('returns an error', async () => {
    const res = await handleIntent('frobnicate', {}, fullContext())
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Unknown action/)
  })
})

describe('matchChoreByTitle', () => {
  const chores = [CHORE_A, CHORE_B, CHORE_C]
  it('prefers an exact case-insensitive match over a substring', () => {
    const withDupPrefix: IntentChore = { ...CHORE_A, id: 5, sync_id: 'x', name: 'Mop kitchen floor' }
    const m = matchChoreByTitle([CHORE_A, withDupPrefix], 'Mop kitchen')
    expect(m).toEqual({ kind: 'one', chore: CHORE_A, fuzzy: false })
  })
  it('reports none', () => {
    expect(matchChoreByTitle(chores, 'nope')).toEqual({ kind: 'none' })
  })
})
