import { describe, it, expect, vi } from 'vitest'
import { buildEnvelope, ACTIONS, EVENTS, SOURCE_APPS } from '@glance-apps/intents'
import { processNotifyEnvelope } from './processNotifyEnvelope'

// TEST B — wiring gate
// Verifies that processNotifyEnvelope passes payload.event_id (the stable
// transition ID, identical across every device that processes the same notify
// event) as syncId to logCompletion — NOT envelope.event_id (which is
// timestamp-plus-random and differs per emission/device).
describe('processNotifyEnvelope – syncId wiring', () => {
  it('passes payload.event_id as syncId, not envelope.event_id', async () => {
    const PAYLOAD_EVENT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    const COMPLETED_AT = '2026-05-29T10:00:00.000Z'

    // Build a real notify envelope via the @glance-apps/intents package.
    // We do NOT set the optional `eventId` arg on buildEnvelope, so
    // envelope.event_id is a fresh random timestamp-based value — distinct
    // from PAYLOAD_EVENT_ID. That distinction is what this test protects.
    const envelope = buildEnvelope({
      action: ACTIONS.NOTIFY,
      payload: {
        event_id: PAYLOAD_EVENT_ID,
        source_app: SOURCE_APPS.LASTGLANCE,
        source_entity_id: '42',
        event: EVENTS.COMPLETED,
        task_id: 'tsk_abc',
        title: 'Replace HVAC filter',
        timestamp: COMPLETED_AT,
        completed_at: COMPLETED_AT,
      },
      emittedBy: SOURCE_APPS.DAYGLANCE,
    })

    // Confirm the two event_id fields are indeed distinct — the test is only
    // meaningful if they differ.
    expect(envelope.event_id).not.toBe(PAYLOAD_EVENT_ID)

    const logCompletion = vi.fn().mockResolvedValue(1)
    const getChore = vi.fn().mockResolvedValue({ id: 42, name: 'Replace HVAC filter' })

    await processNotifyEnvelope(envelope, {
      getChore,
      logCompletion,
      addActivityEntry: vi.fn(),
    })

    expect(logCompletion).toHaveBeenCalledOnce()

    const [calledChoreId, calledOpts] = logCompletion.mock.calls[0] as [number, { syncId?: string }]
    expect(calledChoreId).toBe(42)
    // Must equal payload.event_id — the stable shared transition ID
    expect(calledOpts.syncId).toBe(PAYLOAD_EVENT_ID)
    // Must NOT equal the per-emission envelope.event_id
    expect(calledOpts.syncId).not.toBe(envelope.event_id)
  })

  it('does not call logCompletion when chore is not found', async () => {
    const envelope = buildEnvelope({
      action: ACTIONS.NOTIFY,
      payload: {
        event_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        source_app: SOURCE_APPS.LASTGLANCE,
        source_entity_id: '99',
        event: EVENTS.COMPLETED,
        task_id: 'tsk_xyz',
        title: 'Some chore',
        timestamp: '2026-05-29T10:00:00.000Z',
      },
      emittedBy: SOURCE_APPS.DAYGLANCE,
    })

    const logCompletion = vi.fn()
    await processNotifyEnvelope(envelope, {
      getChore: vi.fn().mockResolvedValue(undefined),
      logCompletion,
      addActivityEntry: vi.fn(),
    })

    expect(logCompletion).not.toHaveBeenCalled()
  })
})
