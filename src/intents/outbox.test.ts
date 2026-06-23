import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createOutbox,
  createIndexedDbOutboxStore,
  MAX_OUTBOX_ATTEMPTS,
  type OutboxIntent,
  type Deliverer,
  type DeliveryResult,
} from './outbox'

// Each test gets its own IndexedDB database name so state never leaks between
// tests. The store IS a real IndexedDB store (backed by fake-indexeddb), so the
// durability assertions exercise genuine persistence, not an in-memory shim.
let dbSeq = 0
function freshOutbox() {
  const dbName = `lg-intents-outbox-test-${dbSeq++}`
  // Expose the db name so a test can build a SECOND store/outbox over the same
  // database to simulate an app restart ("reload").
  return { dbName, ...createOutbox(createIndexedDbOutboxStore(dbName)) }
}

function makeIntent(id: string): OutboxIntent {
  return {
    event_id: id,
    action: 'create',
    payload: {
      title: 'Water the plants',
      due: '2026-06-23',
      all_day: true,
      source_app: 'lastGLANCE',
      source_entity_id: 'chore-1',
    },
    emitted_by: 'lastGLANCE',
    emitted_at: '2026-06-23T00:00:00.000Z',
  }
}

// A scripted deliverer: returns the next result in `script`, then repeats the
// last one. Records how many times it was called.
function scriptedDeliverer(...script: DeliveryResult[]): Deliverer & { calls: number } {
  let calls = 0
  const fn: Deliverer = async () => {
    const i = Math.min(calls, script.length - 1)
    calls++
    return script[i]
  }
  // defineProperty (not Object.assign) so `calls` stays a live accessor.
  Object.defineProperty(fn, 'calls', { get: () => calls })
  return fn as Deliverer & { calls: number }
}

// A manually-resolved deliverer for driving overlap/concurrency. `called`
// resolves the moment the deliverer is first invoked, so a test can wait for the
// first flush to actually park inside deliver() before probing for overlap.
type DeferredDeliverer = Deliverer & {
  calls: number
  resolve: (r: DeliveryResult) => void
  called: Promise<void>
}
function deferredDeliverer(): DeferredDeliverer {
  let calls = 0
  let resolveFn: (r: DeliveryResult) => void = () => {}
  let signalCalled: () => void = () => {}
  const called = new Promise<void>((res) => { signalCalled = res })
  const fn: Deliverer = () => {
    calls++
    signalCalled()
    return new Promise<DeliveryResult>((res) => { resolveFn = res })
  }
  Object.defineProperty(fn, 'calls', { get: () => calls })
  Object.defineProperty(fn, 'resolve', { value: (r: DeliveryResult) => resolveFn(r) })
  Object.defineProperty(fn, 'called', { value: called })
  return fn as DeferredDeliverer
}

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
})

describe('intents outbox', () => {
  // (a) enqueue is durable and survives a simulated reload.
  it('persists an enqueued intent that survives a simulated reload', async () => {
    const ob = freshOutbox()
    await ob.enqueue(makeIntent('evt-1'), ['vault'])
    expect(await ob.pendingCount()).toBe(1)

    // "Reload": a brand-new store + outbox over the SAME database.
    const reloaded = createOutbox(createIndexedDbOutboxStore(ob.dbName))
    const entries = await reloaded.list()
    expect(entries).toHaveLength(1)

    const entry = entries[0]
    expect(entry.id).toBe('evt-1')
    expect(entry.intent.event_id).toBe('evt-1')
    expect(entry.targets).toEqual({ vault: 'pending' })

    // Hard requirement: the RAW intent is stored, never an envelope. The
    // persisted intent must carry the cleartext action/payload and must NOT carry
    // any envelope markers.
    expect(entry.intent.action).toBe('create')
    expect(entry.intent.payload).toMatchObject({ source_entity_id: 'chore-1' })
    const stored = entry.intent as unknown as Record<string, unknown>
    expect(stored.encrypted).toBeUndefined()
    expect(stored.payload_ciphertext).toBeUndefined()
    expect(stored.iv).toBeUndefined()
    expect(stored.salt).toBeUndefined()
    expect(stored.schema_version).toBeUndefined()
  })

  // (b) a transient-fail target stays pending, is retried, then delivered+removed.
  it('retries a transient-fail target until delivered, then removes the entry', async () => {
    const ob = freshOutbox()
    const vault = scriptedDeliverer('transient-fail', 'delivered')
    await ob.enqueue(makeIntent('evt-2'), ['vault'])

    await ob.flush({ vault })
    let entries = await ob.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].targets.vault).toBe('pending')
    expect(entries[0].attempts.vault).toBe(1)
    expect(vault.calls).toBe(1)

    await ob.flush({ vault })
    entries = await ob.list()
    expect(entries).toHaveLength(0)
    expect(await ob.pendingCount()).toBe(0)
    expect(vault.calls).toBe(2)
  })

  // (c) multi-target partial delivery retries ONLY the failed target, never
  // re-delivers the delivered one, and removes the entry when all are done.
  it('retries only the failed target on a multi-target entry', async () => {
    const ob = freshOutbox()
    const webdav = scriptedDeliverer('delivered')
    const vault = scriptedDeliverer('transient-fail', 'delivered')
    await ob.enqueue(makeIntent('evt-3'), ['webdav', 'vault'])

    await ob.flush({ webdav, vault })
    let entries = await ob.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].targets.webdav).toBe('delivered')
    expect(entries[0].targets.vault).toBe('pending')
    expect(webdav.calls).toBe(1)
    expect(vault.calls).toBe(1)

    await ob.flush({ webdav, vault })
    entries = await ob.list()
    expect(entries).toHaveLength(0)
    // webdav was already delivered — it must NOT be called again.
    expect(webdav.calls).toBe(1)
    expect(vault.calls).toBe(2)
    expect(await ob.pendingCount()).toBe(0)
  })

  // (d) duplicate enqueue is a no-op and does not reset existing progress.
  it('treats a duplicate enqueue as a no-op without resetting progress', async () => {
    const ob = freshOutbox()
    const vault = scriptedDeliverer('transient-fail')
    await ob.enqueue(makeIntent('evt-4'), ['vault'])

    // Make some progress (one transient failure -> attempts == 1).
    await ob.flush({ vault })
    expect((await ob.list())[0].attempts.vault).toBe(1)

    // Re-enqueue the SAME event_id: must not add a second entry nor reset attempts.
    await ob.enqueue(makeIntent('evt-4'), ['vault'])
    const entries = await ob.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].attempts.vault).toBe(1)
    expect(await ob.pendingCount()).toBe(1)
  })

  // (e) give-up: on permanent-fail, immediately; on transient, after the bound.
  // Either way the give-up is logged loudly and the entry is removed once all
  // targets are delivered-or-given-up.
  it('gives up immediately on a permanent-fail, logging loudly', async () => {
    const ob = freshOutbox()
    const vault = scriptedDeliverer('permanent-fail')
    await ob.enqueue(makeIntent('evt-5'), ['vault'])

    await ob.flush({ vault })
    expect(await ob.pendingCount()).toBe(0) // sole target given up -> entry removed
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const msg = String(errorSpy.mock.calls[0][0])
    expect(msg).toContain('evt-5')
    expect(msg).toContain('vault')
  })

  it('gives up after MAX_OUTBOX_ATTEMPTS transient failures', async () => {
    const ob = freshOutbox()
    const vault = scriptedDeliverer('transient-fail') // always transient
    await ob.enqueue(makeIntent('evt-6'), ['vault'])

    // One short of the bound: still pending, still owed.
    for (let i = 0; i < MAX_OUTBOX_ATTEMPTS - 1; i++) await ob.flush({ vault })
    let entries = await ob.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].targets.vault).toBe('pending')
    expect(entries[0].attempts.vault).toBe(MAX_OUTBOX_ATTEMPTS - 1)
    expect(errorSpy).not.toHaveBeenCalled()

    // The flush that reaches the bound: give up, log, remove.
    await ob.flush({ vault })
    expect(await ob.pendingCount()).toBe(0)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    const msg = String(errorSpy.mock.calls[0][0])
    expect(msg).toContain('evt-6')
    expect(msg).toContain('vault')
  })

  it('removes a multi-target entry when one target is delivered and the other is given up', async () => {
    const ob = freshOutbox()
    const webdav = scriptedDeliverer('delivered')
    const vault = scriptedDeliverer('permanent-fail')
    await ob.enqueue(makeIntent('evt-7'), ['webdav', 'vault'])

    await ob.flush({ webdav, vault })
    // webdav delivered, vault given-up -> no target pending -> entry removed.
    expect(await ob.pendingCount()).toBe(0)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0][0])).toContain('vault')
  })

  // (f) overlapping flushes do not double-deliver.
  it('guards against overlapping flushes double-delivering', async () => {
    const ob = freshOutbox()
    const vault = deferredDeliverer()
    await ob.enqueue(makeIntent('evt-8'), ['vault'])

    // Start a flush; it parks inside the (not-yet-resolved) deliverer.
    const first = ob.flush({ vault })
    // Wait until the first flush has actually reached the awaited deliver() call.
    await vault.called
    expect(vault.calls).toBe(1)

    // A concurrent flush while the first is in flight must be a no-op.
    await ob.flush({ vault })
    expect(vault.calls).toBe(1)

    // Let the first flush complete successfully.
    vault.resolve('delivered')
    await first
    expect(vault.calls).toBe(1)
    expect(await ob.pendingCount()).toBe(0)
  })
})
