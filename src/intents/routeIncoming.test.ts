import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { buildEncryptedEnvelope, buildEnvelope, deriveIntentsRootKey, ACTIONS } from '@glance-apps/intents'
import type { Envelope, IntentEventRow } from '@glance-apps/intents'
import { routeIncomingVaultRow, KeyNotAvailableError } from './routeIncoming'
import { receiveAllIntents, MAX_INTENT_RETRIES, type ListPage } from './dbTransport'

beforeAll(() => {
  if (!(globalThis as { crypto?: Crypto }).crypto) {
    ;(globalThis as { crypto?: Crypto }).crypto = webcrypto as unknown as Crypto
  }
})

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { errorSpy.mockRestore() })

const createArgs = {
  action: ACTIONS.CREATE,
  payload: { title: 'Water the plants', source_app: 'app.lastglance', source_entity_id: 'chore-1' },
  emittedBy: 'app.lastglance',
  eventId: 'evt-1',
} as const

function keyFrom(pass: string, fill: number): Promise<CryptoKey> {
  return deriveIntentsRootKey(pass, new Uint8Array(16).fill(fill))
}
async function rootKey(): Promise<CryptoKey> {
  return keyFrom('test-passphrase', 7)
}

async function deriveEnvelopeKeyFor(key: CryptoKey, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const { deriveEnvelopeKey } = await import('@glance-apps/intents')
  return deriveEnvelopeKey(key, salt)
}
async function encryptedRow(key: CryptoKey, eventId = 'evt-1', seq = 1): Promise<IntentEventRow> {
  const env = await buildEncryptedEnvelope({ ...createArgs, eventId }, (salt) => deriveEnvelopeKeyFor(key, salt))
  return { eventId, envelope: env, seq, expiresAt: '', serverMtime: '' } as unknown as IntentEventRow
}
function rowFrom(envelope: unknown): IntentEventRow {
  return { eventId: 'evt-1', envelope, seq: 1, expiresAt: '', serverMtime: '' } as unknown as IntentEventRow
}

describe('vault receive routing — plaintext rejection & decrypt outcomes', () => {
  it('rejects a plaintext row without routing it', async () => {
    const plaintext = buildEnvelope(createArgs) // a normal, NON-encrypted envelope
    const handleEnvelope = vi.fn(async () => {})
    const activity: Array<{ type: string; message: string }> = []

    const outcome = await routeIncomingVaultRow(rowFrom(plaintext), {
      loadRootKey: async () => rootKey(),
      handleEnvelope,
      addActivityEntry: (e) => activity.push(e),
    })

    expect(outcome).toBe('rejected')
    expect(handleEnvelope).not.toHaveBeenCalled() // never routed
    expect(errorSpy).toHaveBeenCalledTimes(1) // logged loudly
    expect(String(errorSpy.mock.calls[0][0])).toContain('evt-1')
    expect(activity.some((a) => a.type === 'error' && a.message.includes('evt-1'))).toBe(true)
  })

  it('decrypts and routes an encrypted row', async () => {
    const key = await rootKey()
    const routed: Envelope[] = []
    const outcome = await routeIncomingVaultRow(await encryptedRow(key), {
      loadRootKey: async () => key,
      handleEnvelope: async (env) => { routed.push(env) },
      addActivityEntry: () => {},
    })

    expect(outcome).toBe('processed')
    expect(routed).toHaveLength(1)
    expect(routed[0].event_id).toBe('evt-1')
    expect(errorSpy).not.toHaveBeenCalled()
  })

  // KEY NOT AVAILABLE -> TRANSIENT: throws (so the drain holds + retries) rather
  // than returning a terminal outcome.
  it('throws KeyNotAvailableError (transient) when no key is cached', async () => {
    const key = await rootKey()
    const handleEnvelope = vi.fn(async () => {})

    await expect(
      routeIncomingVaultRow(await encryptedRow(key), {
        loadRootKey: async () => null, // key not set up yet
        handleEnvelope,
        addActivityEntry: () => {},
      }),
    ).rejects.toBeInstanceOf(KeyNotAvailableError)
    expect(handleEnvelope).not.toHaveBeenCalled()
  })

  // (b) DECRYPT FAILED WITH KEY PRESENT -> PERMANENT: returns 'skipped' (advance)
  // and logs; does NOT throw.
  it('returns skipped (permanent) when a key is present but the row is undecryptable', async () => {
    const keyA = await keyFrom('passA', 7)
    const keyB = await keyFrom('passB', 9) // different key -> wrong-key decrypt
    const row = await encryptedRow(keyA)
    const handleEnvelope = vi.fn(async () => {})
    const activity: Array<{ type: string; message: string }> = []

    const outcome = await routeIncomingVaultRow(row, {
      loadRootKey: async () => keyB, // key present, but the wrong one
      handleEnvelope,
      addActivityEntry: (e) => activity.push(e),
    })

    expect(outcome).toBe('skipped') // terminal: advance past the bad row
    expect(handleEnvelope).not.toHaveBeenCalled()
    expect(activity.some((a) => a.type === 'error' && a.message.includes('evt-1'))).toBe(true)
  })
})

// ── Integration with the receive drain (cursor + bounded retry) ───────────────

function memCounters() {
  const counts = new Map<number, number>()
  return {
    recordFailure: (seq: number) => { const n = (counts.get(seq) ?? 0) + 1; counts.set(seq, n); return n },
    clearFailure: (seq: number) => { counts.delete(seq) },
    getCount: (seq: number) => counts.get(seq) ?? 0,
  }
}

// Drives receiveAllIntents over a single encrypted row at the given seq, routing
// through routeIncomingVaultRow with a (possibly absent) key.
function harness(row: IntentEventRow, getKey: () => CryptoKey | null) {
  let cursor: number | null = null
  const counters = memCounters()
  const handleEnvelope = vi.fn(async () => {})
  const onGiveUp = vi.fn()
  const routed: Envelope[] = []

  async function runOnce() {
    return receiveAllIntents({
      getCursor: () => cursor,
      setCursor: (seq) => { cursor = seq },
      // Return the row only while the cursor sits below it; empty once advanced.
      listPage: async (since): Promise<ListPage> => ({ rows: since < row.seq ? [row] : [], hasMore: false }),
      processRow: async (r) => {
        await routeIncomingVaultRow(r, {
          loadRootKey: async () => getKey(),
          handleEnvelope: async (env) => { routed.push(env); await handleEnvelope() },
          addActivityEntry: () => {},
        })
      },
      recordFailure: counters.recordFailure,
      clearFailure: counters.clearFailure,
      onGiveUp,
    })
  }

  return { runOnce, getCursor: () => cursor, counters, handleEnvelope, onGiveUp, routed }
}

describe('vault receive — decrypt/key failures in the bounded-retry model', () => {
  // (a) key-absent decrypt does NOT advance the cursor; once the key is present
  // a later poll decrypts and processes it.
  it('holds (no cursor advance) on key-absent, then processes once keyed', async () => {
    const key = await rootKey()
    const row = await encryptedRow(key, 'evt-1', 10)
    let currentKey: CryptoKey | null = null
    const h = harness(row, () => currentKey)

    await h.runOnce() // key absent -> transient throw -> hold
    expect(h.getCursor()).toBeNull() // cursor NOT advanced
    expect(h.handleEnvelope).not.toHaveBeenCalled()
    expect(h.counters.getCount(10)).toBe(1) // one recorded failure, will retry
    expect(h.onGiveUp).not.toHaveBeenCalled()

    currentKey = key // encryption now set up
    await h.runOnce() // retry from the same cursor -> decrypts + processes
    expect(h.handleEnvelope).toHaveBeenCalledTimes(1)
    expect(h.routed[0].event_id).toBe('evt-1')
    expect(h.getCursor()).toBe(10) // advanced only after success
    expect(h.counters.getCount(10)).toBe(0) // failure counter cleared
  })

  // (c) a persistently key-absent row gives up at the bound (advance + onGiveUp),
  // so it can't wedge the channel forever.
  it('gives up at MAX_INTENT_RETRIES when the key never arrives', async () => {
    const key = await rootKey()
    const row = await encryptedRow(key, 'evt-1', 10)
    const h = harness(row, () => null) // key never available

    // Each poll records one failure and holds, until the bound is hit.
    for (let i = 0; i < MAX_INTENT_RETRIES - 1; i++) {
      await h.runOnce()
      expect(h.getCursor()).toBeNull() // still held
      expect(h.onGiveUp).not.toHaveBeenCalled()
    }

    await h.runOnce() // this poll reaches the bound -> give up
    expect(h.onGiveUp).toHaveBeenCalledTimes(1)
    expect(h.onGiveUp.mock.calls[0][0]).toMatchObject({ eventId: 'evt-1' }) // logged with eventId
    expect(h.getCursor()).toBe(10) // advanced past so the channel can't wedge
    expect(h.handleEnvelope).not.toHaveBeenCalled()
  })
})
