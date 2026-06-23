import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { buildEncryptedEnvelope, buildEnvelope, deriveIntentsRootKey, ACTIONS } from '@glance-apps/intents'
import type { Envelope, IntentEventRow } from '@glance-apps/intents'
import { routeIncomingVaultRow } from './routeIncoming'

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

async function rootKey(): Promise<CryptoKey> {
  return deriveIntentsRootKey('test-passphrase', new Uint8Array(16).fill(7))
}

function rowFrom(envelope: unknown): IntentEventRow {
  // parseIntentRow normally produces this; we only need the fields the router reads.
  return { eventId: 'evt-1', envelope, seq: 1, expiresAt: '', serverMtime: '' } as unknown as IntentEventRow
}

describe('vault receive routing — plaintext rejection', () => {
  // (d) a NON-encrypted row on the vault is rejected: permanent-bad, logged
  // loudly, NOT routed, parseEnvelope never reached.
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

  // (d cont.) an ENCRYPTED row is processed normally.
  it('decrypts and routes an encrypted row', async () => {
    const key = await rootKey()
    const encrypted = await buildEncryptedEnvelope(createArgs, (salt) => deriveEnvelopeKeyFor(key, salt))

    const routed: Envelope[] = []
    const outcome = await routeIncomingVaultRow(rowFrom(encrypted), {
      loadRootKey: async () => key,
      handleEnvelope: async (env) => { routed.push(env) },
      addActivityEntry: () => {},
    })

    expect(outcome).toBe('processed')
    expect(routed).toHaveLength(1)
    expect(routed[0].event_id).toBe('evt-1')
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('skips (does not reject) an encrypted row when no key is available', async () => {
    const key = await rootKey()
    const encrypted = await buildEncryptedEnvelope(createArgs, (salt) => deriveEnvelopeKeyFor(key, salt))
    const handleEnvelope = vi.fn(async () => {})

    const outcome = await routeIncomingVaultRow(rowFrom(encrypted), {
      loadRootKey: async () => null,
      handleEnvelope,
      addActivityEntry: () => {},
    })

    expect(outcome).toBe('skipped')
    expect(handleEnvelope).not.toHaveBeenCalled()
  })
})

// Local copy of the deriveEnvelopeKey wiring so the test builds an encrypted
// envelope with the same root key the router decrypts with.
async function deriveEnvelopeKeyFor(key: CryptoKey, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const { deriveEnvelopeKey } = await import('@glance-apps/intents')
  return deriveEnvelopeKey(key, salt)
}
