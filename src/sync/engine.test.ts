import { describe, it, expect } from 'vitest'
import { mergePayloads, reconcilePinTies } from './engine'
import type { SyncPayload } from './types'

// TEST A — merge gate
// Two devices each process the same notify event and write a CompletionEvent
// with the same sync_id (the inbound payload.event_id). mergePayloads must
// collapse them to exactly one record, not union them into two.
describe('mergePayloads – CompletionEvent dedup on matching sync_id', () => {
  it('collapses two CompletionEvents with identical id to one record', () => {
    const TRANSITION_ID = '11111111-1111-1111-1111-111111111111'
    const CHORE_SYNC_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
    const COMPLETED_AT = '2026-05-29T10:00:00.000Z'

    const record = {
      id: TRANSITION_ID,
      choreSyncId: CHORE_SYNC_ID,
      completedAt: COMPLETED_AT,
      note: null,
      source: 'dayglance' as const,
      completedByUserSyncId: null,
    }

    // Device A's local payload after processing the notify event
    const localPayload: SyncPayload = {
      categories: [],
      chores: [],
      completionEvents: [record],
      tombstones: {},
      users: [],
      settings: { multiUserEnabled: false },
    }

    // Device B's payload — same event processed independently, same stable id
    const remotePayload: SyncPayload = {
      categories: [],
      chores: [],
      completionEvents: [{ ...record }],
      tombstones: {},
      users: [],
      settings: { multiUserEnabled: false },
    }

    const { data } = mergePayloads(localPayload, remotePayload)
    const merged = (data as SyncPayload).completionEvents

    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe(TRANSITION_ID)
  })
})

describe('pins dropped by a build that predates pinning (file tier)', () => {
  const ID = 'f7f7f7f7-f7f7-f7f7-f7f7-f7f7f7f7f7f7'
  const AT = '2026-10-27T23:10:00.000Z'
  const chore = (extra: Record<string, unknown>) => ({
    id: ID, name: 'Algae discs', categorySyncId: null, sortOrder: 0, targetCadenceDays: 7,
    notifyWhenOverdue: false, autoScheduleToDayglance: false, preferredScheduleBehavior: null,
    seasonalStart: null, seasonalEnd: null, details: null, icon: 'Fish', assignedUserSyncIds: [],
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: AT, ...extra,
  })
  const payload = (c: Record<string, unknown>) =>
    ({ chores: [c], categories: [], completionEvents: [], users: [], settings: { multiUserEnabled: false }, tombstones: {} })
  const pinnedIn = (data: unknown) => ((data as SyncPayload).chores[0] as { pinned?: boolean }).pinned

  it('restores the pin locally when only the remote copy kept it', () => {
    const { data, localChanged } = mergePayloads(payload(chore({ pinned: false })), payload(chore({ pinned: true })))
    expect(pinnedIn(data)).toBe(true)
    expect(localChanged).toBe(true)
  })

  it('re-uploads the pin when a stale copy overwrote the remote', () => {
    const { data, remoteChanged } = mergePayloads(payload(chore({ pinned: true })), payload(chore({ pinned: false })))
    expect(pinnedIn(data)).toBe(true)
    expect(remoteChanged).toBe(true)
  })

  it('treats a remote with no pinned key (an older build) the same way', () => {
    const { data, remoteChanged } = mergePayloads(payload(chore({ pinned: true })), payload(chore({})))
    expect(pinnedIn(data)).toBe(true)
    expect(remoteChanged).toBe(true)
  })

  it('leaves a real unpin alone: it carries a newer updatedAt, so it is not a tie', () => {
    const unpinned = chore({ pinned: false, updatedAt: '2026-10-27T23:10:05.000Z' })
    const { data } = mergePayloads(payload(unpinned), payload(chore({ pinned: true })))
    expect(pinnedIn(data)).toBe(false)
  })

  it('reports nothing changed when both sides agree', () => {
    const r = reconcilePinTies([chore({ pinned: true })], [chore({ pinned: true })])
    expect(r.localChanged || r.remoteChanged).toBe(false)
  })
})
