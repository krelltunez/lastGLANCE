import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { deriveIntentsRootKey } from '@glance-apps/intents'
import { emitCreateIntent, buildCreateIntent, enabledIntentTargets, type EmitDeps } from './emitter'
import { createOutbox, createIndexedDbOutboxStore } from './outbox'
import type { OutboxIntent, TransportName, Deliverer } from './outbox'
import { createVaultDeliverer } from './deliverers'
import { getIntentsConfig, saveIntentsConfig, DEFAULT_CONFIG } from './config'
import { getDbIntentsConfig, saveDbIntentsConfig } from './dbConfig'
import { setVaultConfig } from '@/sync/vaultConfig'
import type { ChoreWithLastCompletion } from '@/types'

beforeAll(() => {
  if (!(globalThis as { crypto?: Crypto }).crypto) {
    ;(globalThis as { crypto?: Crypto }).crypto = webcrypto as unknown as Crypto
  }
})

// Minimal in-memory localStorage so config readers/writers work in node.
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
})

const chore = { name: 'Water the plants', sync_id: 'chore-1', assigned_user_sync_ids: [] } as unknown as ChoreWithLastCompletion

let dbSeq = 0
function freshStore() { return createIndexedDbOutboxStore(`emit-test-${dbSeq++}`) }

function decodeRowEnvelope(b64: string): Record<string, unknown> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}
async function realRootKey(): Promise<CryptoKey> {
  return deriveIntentsRootKey('test-passphrase', new Uint8Array(16).fill(7))
}

// emitCreateIntent triggers flush fire-and-forget (it does NOT await delivery).
// This helper emits and then awaits the triggered flush so assertions about
// delivery are deterministic.
async function emitAndAwaitFlush(
  ob: ReturnType<typeof createOutbox>,
  deliverers: Record<string, Deliverer>,
): Promise<void> {
  let flushPromise: Promise<void> = Promise.resolve()
  await emitCreateIntent(chore, {
    targets: () => Object.keys(deliverers) as TransportName[],
    enqueue: (i, t) => ob.enqueue(i, t),
    flush: () => { flushPromise = ob.flush(deliverers); return flushPromise },
  })
  await flushPromise
}

describe('emit -> outbox wiring', () => {
  // (a) an emit enqueues a RAW intent (not an envelope) with a stable event_id
  // and the correct targets.
  it('enqueues a raw intent with a stable event_id and the given targets', async () => {
    const enqueued: { intent: OutboxIntent; targets: TransportName[] }[] = []
    const deps: EmitDeps = {
      targets: () => ['webdav', 'vault'],
      enqueue: async (intent, targets) => { enqueued.push({ intent, targets }) },
      flush: async () => {},
    }

    const ok = await emitCreateIntent(chore, deps)
    expect(ok).toBe(true)
    expect(enqueued).toHaveLength(1)

    const { intent, targets } = enqueued[0]
    expect(targets).toEqual(['webdav', 'vault'])
    // Stable id stamped at emit, used as entry id == server idempotency key.
    expect(intent.event_id).toMatch(/.+/)
    expect(intent.action).toBe('create')
    expect(intent.emitted_by).toBe('app.lastglance')
    // RAW intent — cleartext payload, NOT an envelope.
    expect(intent.payload).toMatchObject({ title: 'Water the plants', source_entity_id: 'chore-1' })
    const asRecord = intent as unknown as Record<string, unknown>
    expect(asRecord.encrypted).toBeUndefined()
    expect(asRecord.payload_ciphertext).toBeUndefined()
    expect(asRecord.salt).toBeUndefined()
  })

  it('returns false and enqueues nothing when no transport is enabled', async () => {
    const enqueue = vi.fn(async () => {})
    const ok = await emitCreateIntent(chore, { targets: () => [], enqueue, flush: async () => {} })
    expect(ok).toBe(false)
    expect(enqueue).not.toHaveBeenCalled()
  })

  // enabledIntentTargets reflects the real config.
  it('derives targets from config: webdav when configured, vault when enabled', async () => {
    expect(enabledIntentTargets()).toEqual([])

    saveIntentsConfig({ ...DEFAULT_CONFIG, enabled: true, webdavUrl: 'https://x', webdavUsername: 'u', webdavPassword: 'p' })
    expect(enabledIntentTargets()).toEqual(['webdav'])

    setVaultConfig({ enabled: true, vaultUrl: 'https://v', vaultToken: 't', accountId: 'a' })
    saveDbIntentsConfig({ ...getDbIntentsConfig(), enabled: true })
    expect(enabledIntentTargets()).toEqual(['webdav', 'vault'])

    // sanity: getIntentsConfig round-trips
    expect(getIntentsConfig().enabled).toBe(true)
  })

  // (b) flush delivers via deliverers; entry removed on success.
  it('flush delivers a queued intent and removes the entry on success', async () => {
    const ob = createOutbox(freshStore())
    const webdav: Deliverer = async () => 'delivered'
    const vault: Deliverer = async () => 'delivered'

    await emitAndAwaitFlush(ob, { webdav, vault })

    expect(await ob.pendingCount()).toBe(0) // both delivered -> entry removed
  })

  // (c) vault enabled but key absent: vault target stays pending/retried while
  // webdav delivers; nothing is lost; once the key exists, vault delivers.
  it('holds the vault target (key absent) while webdav delivers, then delivers vault once keyed', async () => {
    const ob = createOutbox(freshStore())
    let key: CryptoKey | null = null
    const webdav: Deliverer = async () => 'delivered'
    const vault = createVaultDeliverer({
      loadRootKey: async () => key,          // null at first -> transient
      ttlMs: () => 1000,
      send: async () => ({ ok: true, status: 200 }),
    })

    await emitAndAwaitFlush(ob, { webdav, vault })

    // webdav delivered, vault still pending (key missing) — entry retained, no loss.
    const entries = await ob.list()
    expect(entries).toHaveLength(1)
    expect(entries[0].targets.webdav).toBe('delivered')
    expect(entries[0].targets.vault).toBe('pending')

    // Key becomes available (2b-i): next flush delivers vault and removes the entry.
    key = await realRootKey()
    await ob.flush({ webdav, vault })
    expect(await ob.pendingCount()).toBe(0)
  })

  // (d) the auto-schedule "sent today" marker is gated on a SUCCESSFUL enqueue:
  // a failed enqueue yields false, so the marker is not written.
  it('does not mark sent-today when the enqueue fails', async () => {
    const failing: EmitDeps = {
      targets: () => ['vault'],
      enqueue: async () => { throw new Error('persist failed') },
      flush: async () => {},
    }
    // Mirror the hook's guard: `const queued = await emit(...).catch(() => false)`.
    let marker: string | null = null
    const queued = await emitCreateIntent(chore, failing).catch(() => false)
    if (queued) marker = 'today'

    expect(queued).toBe(false)
    expect(marker).toBeNull() // not suppressed for the day; will retry next pass

    // Positive control: a successful enqueue DOES set the marker.
    const okDeps: EmitDeps = { targets: () => ['vault'], enqueue: async () => {}, flush: async () => {} }
    const queued2 = await emitCreateIntent(chore, okDeps).catch(() => false)
    if (queued2) marker = 'today'
    expect(marker).toBe('today')
  })

  // (e) end-to-end: emit -> enqueue -> flush -> the vault deliverer builds an
  // ENCRYPTED row and POSTs it.
  it('end-to-end: emit produces an encrypted vault row on flush', async () => {
    const ob = createOutbox(freshStore())
    const sent: Array<Array<{ envelope: string }>> = []
    const vault = createVaultDeliverer({
      loadRootKey: realRootKey,
      ttlMs: () => 1000,
      send: async (events) => { sent.push(events as Array<{ envelope: string }>); return { ok: true, status: 200 } },
    })

    await emitAndAwaitFlush(ob, { vault })

    expect(await ob.pendingCount()).toBe(0) // delivered
    expect(sent).toHaveLength(1)
    const env = decodeRowEnvelope(sent[0][0].envelope)
    expect(env.encrypted).toBe(true)
    expect(typeof env.payload_ciphertext).toBe('string')
    expect(env.payload).toBeUndefined() // never plaintext to the vault
  })

  // buildCreateIntent stamps a stable id that becomes the entry id verbatim.
  it('buildCreateIntent stamps a stable event_id reused as the outbox entry id', async () => {
    const intent = buildCreateIntent(chore)
    const ob = createOutbox(freshStore())
    await ob.enqueue(intent, ['vault'])
    const entries = await ob.list()
    expect(entries[0].id).toBe(intent.event_id) // id flows through unchanged
  })
})
