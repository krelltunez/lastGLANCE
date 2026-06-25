import { describe, it, expect, beforeEach } from 'vitest'
import {
  type ActivityEntry,
  applyOutboundDelivery,
  reconcileDeliveryFromFlush,
  addActivityEntry,
  getActivityLog,
} from './config'

// Minimal in-memory localStorage so the reconcile (which reads/writes the
// persisted Activity Log) works in the node test environment. window is absent
// in node, so the change-notification dispatch inside config.ts no-ops safely.
beforeEach(() => {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  } as Storage
  ;(globalThis as { crypto?: Crypto }).crypto ??= { randomUUID: () => `id-${Math.random()}` } as Crypto
})

function outEntry(eventId: string, delivery?: ActivityEntry['delivery']): ActivityEntry {
  return { id: `a-${eventId}`, timestamp: '2026-06-25T00:00:00.000Z', type: 'sent', message: 'Queued', direction: 'out', eventId, delivery }
}

describe('applyOutboundDelivery (forward-only)', () => {
  it('advances queued -> held -> delivered and reports a change each step', () => {
    const log = [outEntry('e1', 'queued')]
    expect(applyOutboundDelivery(log, 'e1', 'held')).toBe(true)
    expect(log[0].delivery).toBe('held')
    expect(applyOutboundDelivery(log, 'e1', 'delivered')).toBe(true)
    expect(log[0].delivery).toBe('delivered')
  })

  it('can jump queued -> delivered directly (key was ready on first flush)', () => {
    const log = [outEntry('e1', 'queued')]
    expect(applyOutboundDelivery(log, 'e1', 'delivered')).toBe(true)
    expect(log[0].delivery).toBe('delivered')
  })

  it('never downgrades and is a no-op (returns false) when not strictly ahead', () => {
    const log = [outEntry('e1', 'delivered')]
    expect(applyOutboundDelivery(log, 'e1', 'held')).toBe(false)
    expect(applyOutboundDelivery(log, 'e1', 'queued')).toBe(false)
    expect(applyOutboundDelivery(log, 'e1', 'delivered')).toBe(false) // unchanged
    expect(log[0].delivery).toBe('delivered')
  })

  it('treats a missing delivery as queued for the rank comparison', () => {
    const log = [outEntry('e1', undefined)]
    expect(applyOutboundDelivery(log, 'e1', 'held')).toBe(true)
    expect(log[0].delivery).toBe('held')
  })

  it('matches only OUTBOUND entries with the given eventId', () => {
    const inbound: ActivityEntry = { id: 'b', timestamp: 't', type: 'received', message: 'in', direction: 'in', eventId: 'e1', delivery: 'queued' }
    const otherId = outEntry('e2', 'queued')
    const log = [inbound, otherId]
    expect(applyOutboundDelivery(log, 'e1', 'delivered')).toBe(false) // inbound ignored
    expect(applyOutboundDelivery(log, 'e2', 'delivered')).toBe(true)
    expect(inbound.delivery).toBe('queued') // untouched
    expect(otherId.delivery).toBe('delivered')
  })
})

describe('reconcileDeliveryFromFlush', () => {
  it('folds delivered + held ids back into the persisted log', () => {
    addActivityEntry({ type: 'sent', direction: 'out', eventId: 'e1', delivery: 'queued', message: 'Queued "A"' })
    addActivityEntry({ type: 'sent', direction: 'out', eventId: 'e2', delivery: 'queued', message: 'Queued "B"' })

    reconcileDeliveryFromFlush({ deliveredIds: ['e1'], heldNoKeyIds: ['e2'] })

    const log = getActivityLog()
    expect(log.find(e => e.eventId === 'e1')?.delivery).toBe('delivered')
    expect(log.find(e => e.eventId === 'e2')?.delivery).toBe('held')
  })

  it('lands on delivered when an id is in both lists (delivered outranks held)', () => {
    addActivityEntry({ type: 'sent', direction: 'out', eventId: 'e1', delivery: 'queued', message: 'Queued "A"' })

    reconcileDeliveryFromFlush({ deliveredIds: ['e1'], heldNoKeyIds: ['e1'] })

    expect(getActivityLog().find(e => e.eventId === 'e1')?.delivery).toBe('delivered')
  })

  it('does not downgrade an already-delivered entry on a later held report', () => {
    addActivityEntry({ type: 'sent', direction: 'out', eventId: 'e1', delivery: 'queued', message: 'Queued "A"' })
    reconcileDeliveryFromFlush({ deliveredIds: ['e1'], heldNoKeyIds: [] })
    // A subsequent pass that (spuriously) reports it held must not move it back.
    reconcileDeliveryFromFlush({ deliveredIds: [], heldNoKeyIds: ['e1'] })
    expect(getActivityLog().find(e => e.eventId === 'e1')?.delivery).toBe('delivered')
  })

  it('is a safe no-op when nothing matches or nothing changes', () => {
    addActivityEntry({ type: 'sent', direction: 'out', eventId: 'e1', delivery: 'delivered', message: 'Queued "A"' })
    const before = JSON.stringify(getActivityLog())
    reconcileDeliveryFromFlush({ deliveredIds: ['nope'], heldNoKeyIds: ['e1'] }) // e1 already delivered, 'nope' absent
    expect(JSON.stringify(getActivityLog())).toBe(before)
  })
})
