import { describe, it, expect } from 'vitest'
import { mergePayloads } from './engine'
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
    }

    // Device A's local payload after processing the notify event
    const localPayload: SyncPayload = {
      categories: [],
      chores: [],
      completionEvents: [record],
      tombstones: {},
    }

    // Device B's payload — same event processed independently, same stable id
    const remotePayload: SyncPayload = {
      categories: [],
      chores: [],
      completionEvents: [{ ...record }],
      tombstones: {},
    }

    const { data } = mergePayloads(localPayload, remotePayload)
    const merged = (data as SyncPayload).completionEvents

    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe(TRANSITION_ID)
  })
})
