import { describe, it, expect, vi } from 'vitest'
import { buildEnvelope, ACTIONS, EVENTS, SOURCE_APPS } from '@glance-apps/intents'
import { processNotifyEnvelope } from './processNotifyEnvelope'

const CHORE_SYNC_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const COMPLETED_AT = '2026-05-29T10:00:00.000Z'

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return buildEnvelope({
    action: ACTIONS.NOTIFY,
    payload: {
      event_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      source_app: SOURCE_APPS.LASTGLANCE,
      source_entity_id: CHORE_SYNC_ID,
      event: EVENTS.COMPLETED,
      task_id: 'tsk_abc',
      title: 'Replace HVAC filter',
      timestamp: COMPLETED_AT,
      completed_at: COMPLETED_AT,
      ...overrides,
    },
    emittedBy: SOURCE_APPS.DAYGLANCE,
  })
}

// TEST B — wiring gate
// Verifies that processNotifyEnvelope passes payload.event_id (the stable
// transition ID, identical across every device that processes the same notify
// event) as syncId to logCompletion — NOT envelope.event_id (which is
// timestamp-plus-random and differs per emission/device).
describe('processNotifyEnvelope – syncId wiring', () => {
  it('passes payload.event_id as syncId, not envelope.event_id', async () => {
    const PAYLOAD_EVENT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

    // Build a real notify envelope via the @glance-apps/intents package.
    // We do NOT set the optional `eventId` arg on buildEnvelope, so
    // envelope.event_id is a fresh random timestamp-based value — distinct
    // from PAYLOAD_EVENT_ID. That distinction is what this test protects.
    const envelope = makeEnvelope({ event_id: PAYLOAD_EVENT_ID })

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

    // getChore must be called with the chore sync_id from source_entity_id,
    // not a parsed integer
    expect(getChore).toHaveBeenCalledWith(CHORE_SYNC_ID)

    expect(logCompletion).toHaveBeenCalledOnce()
    const [calledChoreId, calledOpts] = logCompletion.mock.calls[0] as [number, { syncId?: string; completedByUserSyncId?: string | null }]
    // logCompletion receives the local integer id from the chore object, not
    // parseInt(source_entity_id)
    expect(calledChoreId).toBe(42)
    // Must equal payload.event_id — the stable shared transition ID
    expect(calledOpts.syncId).toBe(PAYLOAD_EVENT_ID)
    // Must NOT equal the per-emission envelope.event_id
    expect(calledOpts.syncId).not.toBe(envelope.event_id)
    // completed_by_user_id absent in payload → null
    expect(calledOpts.completedByUserSyncId).toBeNull()
  })

  it('passes completed_by_user_id when present in payload', async () => {
    const USER_SYNC_ID = 'uuuuuuuu-uuuu-uuuu-uuuu-uuuuuuuuuuuu'

    const envelope = makeEnvelope({ completed_by_user_id: USER_SYNC_ID })

    const logCompletion = vi.fn().mockResolvedValue(1)
    await processNotifyEnvelope(envelope, {
      getChore: vi.fn().mockResolvedValue({ id: 42, name: 'Replace HVAC filter' }),
      logCompletion,
      addActivityEntry: vi.fn(),
    })

    const [, calledOpts] = logCompletion.mock.calls[0] as [number, { completedByUserSyncId?: string | null }]
    expect(calledOpts.completedByUserSyncId).toBe(USER_SYNC_ID)
  })

  it('does not call logCompletion when chore is not found', async () => {
    const envelope = makeEnvelope()

    const logCompletion = vi.fn()
    await processNotifyEnvelope(envelope, {
      getChore: vi.fn().mockResolvedValue(undefined),
      logCompletion,
      addActivityEntry: vi.fn(),
    })

    expect(logCompletion).not.toHaveBeenCalled()
  })

  it('does not call logCompletion when isAlreadyLogged returns true', async () => {
    const envelope = makeEnvelope()

    const logCompletion = vi.fn()
    await processNotifyEnvelope(envelope, {
      getChore: vi.fn().mockResolvedValue({ id: 42, name: 'Replace HVAC filter' }),
      logCompletion,
      addActivityEntry: vi.fn(),
      isAlreadyLogged: vi.fn().mockResolvedValue(true),
    })

    expect(logCompletion).not.toHaveBeenCalled()
  })
})

describe('processNotifyEnvelope – a People task done in dayGLANCE', () => {
  const PERSON = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

  function people(over: Record<string, unknown> = {}) {
    return {
      getPerson: vi.fn(async (id: string) => (id === PERSON ? { name: 'Sam', channel: 'call' as const } : undefined)),
      interactionExists: vi.fn(async () => false),
      logContact: vi.fn(async () => {}),
      ...over,
    }
  }

  it('logs an outbound contact keyed to the notify', async () => {
    const p = people()
    await processNotifyEnvelope(makeEnvelope({ source_entity_id: PERSON }), {
      getChore: vi.fn(async () => undefined), logCompletion: vi.fn(), addActivityEntry: vi.fn(), people: p,
    })
    expect(p.logContact).toHaveBeenCalledWith({
      personSyncId: PERSON, channel: 'call', occurredAt: COMPLETED_AT, syncId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    })
  })

  it('logs once when the notify comes again', async () => {
    const p = people({ interactionExists: vi.fn(async () => true) })
    await processNotifyEnvelope(makeEnvelope({ source_entity_id: PERSON }), {
      getChore: vi.fn(async () => undefined), logCompletion: vi.fn(), addActivityEntry: vi.fn(), people: p,
    })
    expect(p.logContact).not.toHaveBeenCalled()
  })

  it('ignores an id that is neither a chore nor a person (a date item)', async () => {
    const p = people()
    await processNotifyEnvelope(makeEnvelope({ source_entity_id: 'date-1:2026' }), {
      getChore: vi.fn(async () => undefined), logCompletion: vi.fn(), addActivityEntry: vi.fn(), people: p,
    })
    expect(p.logContact).not.toHaveBeenCalled()
  })
})

describe('processNotifyEnvelope – word on a task this device sent', () => {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  } as Storage
  const deps = () => ({ getChore: vi.fn().mockResolvedValue(undefined), logCompletion: vi.fn(), addActivityEntry: vi.fn() })

  it('a completed or deleted notice ends the duplicate-send warning; a reschedule does not', async () => {
    const { recordSent, unansweredSend } = await import('./sentToDayglance')
    const sent = () => recordSent(CHORE_SYNC_ID, { taskId: 't-1', due: '2026-11-15', sentAt: new Date().toISOString() })

    sent()
    await processNotifyEnvelope(makeEnvelope({ event: EVENTS.RESCHEDULED, due: '2026-11-16', previous_due: '2026-11-15' }), deps())
    expect(unansweredSend(CHORE_SYNC_ID)).not.toBeNull()
    await processNotifyEnvelope(makeEnvelope(), deps())
    expect(unansweredSend(CHORE_SYNC_ID)).toBeNull()

    sent()
    await processNotifyEnvelope(makeEnvelope({ event: EVENTS.DELETED, completed_at: undefined }), deps())
    expect(unansweredSend(CHORE_SYNC_ID)).toBeNull()
  })
})
