import { describe, it, expect, beforeAll } from 'vitest'
import { webcrypto } from 'node:crypto'
import { deriveIntentsRootKey } from '@glance-apps/intents'
import { createVaultDeliverer, createWebdavDeliverer } from './deliverers'
import type { OutboxIntent } from './outbox'
import type { IntentsConfig } from './config'

// WebCrypto global for the real encrypt/derive path (Node exposes it; guard anyway).
beforeAll(() => {
  if (!(globalThis as { crypto?: Crypto }).crypto) {
    ;(globalThis as { crypto?: Crypto }).crypto = webcrypto as unknown as Crypto
  }
})

function makeIntent(id = 'evt-1'): OutboxIntent {
  return {
    event_id: id,
    action: 'create',
    payload: {
      title: 'Water the plants',
      due: '2026-06-23',
      all_day: true,
      source_app: 'app.lastglance',
      source_entity_id: 'chore-1',
    },
    emitted_by: 'app.lastglance',
    emitted_at: '2026-06-23T00:00:00.000Z',
  }
}

// Decode an outbound row's base64 envelope back into the structured object.
function decodeRowEnvelope(b64: string): Record<string, unknown> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

async function realRootKey(): Promise<CryptoKey> {
  return deriveIntentsRootKey('test-passphrase', new Uint8Array(16).fill(7))
}

// A capturing send: records the events POSTed and returns a scripted response.
function captureSend(response: { ok: boolean; status: number } | null) {
  const sent: unknown[][] = []
  const fn = async (events: unknown[]) => { sent.push(events); return response }
  return Object.assign(fn, { sent })
}

describe('vault deliverer (always encrypted)', () => {
  // (a) with a cached key, builds an ENCRYPTED envelope and POSTs it.
  it('builds an encrypted envelope and POSTs it when a key is cached', async () => {
    const rootKey = await realRootKey()
    const send = captureSend({ ok: true, status: 200 })
    const deliver = createVaultDeliverer({
      loadRootKey: async () => rootKey,
      ttlMs: () => 60_000,
      send,
    })

    const result = await deliver(makeIntent())
    expect(result).toBe('delivered')

    // Exactly one batch POSTed, carrying one row.
    expect(send.sent).toHaveLength(1)
    const events = send.sent[0] as Array<{ eventId: string; envelope: string }>
    expect(events).toHaveLength(1)
    expect(events[0].eventId).toBe('evt-1')

    // The envelope on the wire is ENCRYPTED: encrypted flag + ciphertext, and NO
    // cleartext payload.
    const env = decodeRowEnvelope(events[0].envelope)
    expect(env.encrypted).toBe(true)
    expect(typeof env.payload_ciphertext).toBe('string')
    expect((env.payload_ciphertext as string).length).toBeGreaterThan(0)
    expect(env.iv).toBeTruthy()
    expect(env.salt).toBeTruthy()
    expect(env.payload).toBeUndefined() // the title etc. is NOT in cleartext
  })

  // (b) no cached key -> 'transient-fail', nothing built or sent.
  it('returns transient and sends nothing when no key is cached', async () => {
    const send = captureSend({ ok: true, status: 200 })
    const deliver = createVaultDeliverer({
      loadRootKey: async () => null,
      ttlMs: () => 60_000,
      send,
    })

    const result = await deliver(makeIntent())
    expect(result).toBe('transient-fail')
    expect(send.sent).toHaveLength(0) // built nothing, sent nothing
  })

  // (c) NEVER plaintext: whatever the send outcome, anything put on the wire is
  // encrypted; and with no key nothing is sent at all.
  it('never emits a plaintext envelope under any condition', async () => {
    const rootKey = await realRootKey()
    for (const response of [
      { ok: true, status: 200 },
      { ok: false, status: 500 },
      { ok: false, status: 400 },
    ] as const) {
      const send = captureSend(response)
      const deliver = createVaultDeliverer({ loadRootKey: async () => rootKey, ttlMs: () => 1000, send })
      await deliver(makeIntent('evt-c'))
      expect(send.sent).toHaveLength(1)
      const events = send.sent[0] as Array<{ envelope: string }>
      const env = decodeRowEnvelope(events[0].envelope)
      expect(env.encrypted).toBe(true)
      expect(env.payload).toBeUndefined()
    }
    // No key -> nothing on the wire (so there is nothing that could be plaintext).
    const send = captureSend({ ok: true, status: 200 })
    const deliver = createVaultDeliverer({ loadRootKey: async () => null, ttlMs: () => 1000, send })
    await deliver(makeIntent('evt-c2'))
    expect(send.sent).toHaveLength(0)
  })

  it('maps vault send outcomes: 2xx->delivered, 5xx->transient, 4xx->permanent, network->transient', async () => {
    const rootKey = await realRootKey()
    const base = { loadRootKey: async () => rootKey, ttlMs: () => 1000 }

    expect(await createVaultDeliverer({ ...base, send: captureSend({ ok: true, status: 200 }) })(makeIntent())).toBe('delivered')
    expect(await createVaultDeliverer({ ...base, send: captureSend({ ok: false, status: 503 }) })(makeIntent())).toBe('transient-fail')
    expect(await createVaultDeliverer({ ...base, send: captureSend({ ok: false, status: 400 }) })(makeIntent())).toBe('permanent-fail')
    expect(await createVaultDeliverer({ ...base, send: captureSend(null) })(makeIntent())).toBe('transient-fail') // no conn
    // A throwing send (network/timeout) is transient.
    const throwing = createVaultDeliverer({ ...base, send: async () => { throw new TypeError('network down') } })
    expect(await throwing(makeIntent())).toBe('transient-fail')
  })
})

describe('webdav deliverer (existing policy)', () => {
  function plaintextConfig(): IntentsConfig {
    return {
      enabled: true,
      webdavUrl: 'https://example.com/dav',
      webdavUsername: 'user',
      webdavPassword: 'pass',
      folderPath: 'GLANCE/events',
      pollIntervalMinutes: 15,
      encryptionEnabled: false,
    }
  }

  function capturePut() {
    const calls: Array<{ filename: string; content: string }> = []
    const fn = async (_c: IntentsConfig, filename: string, content: string) => { calls.push({ filename, content }) }
    return Object.assign(fn, { calls })
  }

  // (e) outcome mapping for the WebDAV deliverer.
  it('maps webdav outcomes correctly', async () => {
    const base = {
      getConfig: plaintextConfig,
      isConfigured: () => true,
      loadRootKey: async () => null,
    }

    // success -> delivered
    expect(await createWebdavDeliverer({ ...base, put: capturePut() })(makeIntent())).toBe('delivered')
    // 5xx -> transient
    expect(await createWebdavDeliverer({ ...base, put: async () => { throw new Error('PUT x.json failed: 500 Server Error') } })(makeIntent())).toBe('transient-fail')
    // 4xx misconfig -> permanent
    expect(await createWebdavDeliverer({ ...base, put: async () => { throw new Error('PUT x.json failed: 403 Forbidden') } })(makeIntent())).toBe('permanent-fail')
    // 429 -> transient
    expect(await createWebdavDeliverer({ ...base, put: async () => { throw new Error('PUT x.json failed: 429 Too Many Requests') } })(makeIntent())).toBe('transient-fail')
    // network error (no status) -> transient
    expect(await createWebdavDeliverer({ ...base, put: async () => { throw new TypeError('fetch failed') } })(makeIntent())).toBe('transient-fail')
    // not configured -> transient (held, not given up)
    expect(await createWebdavDeliverer({ ...base, isConfigured: () => false, put: capturePut() })(makeIntent())).toBe('transient-fail')
  })

  it('keeps the existing plaintext policy when encryption is off', async () => {
    const put = capturePut()
    const deliver = createWebdavDeliverer({
      getConfig: plaintextConfig,
      isConfigured: () => true,
      loadRootKey: async () => null,
      put,
    })
    expect(await deliver(makeIntent())).toBe('delivered')
    // WebDAV with encryption off writes a PLAINTEXT envelope (policy unchanged).
    expect(put.calls).toHaveLength(1)
    const env = JSON.parse(put.calls[0].content)
    expect(env.encrypted).toBeUndefined()
    expect(env.payload).toMatchObject({ title: 'Water the plants' })
    expect(put.calls[0].filename).toBe('evt-1.json')
  })

  it('holds (transient) when webdav encryption is on but the key is missing', async () => {
    const cfg = { ...plaintextConfig(), encryptionEnabled: true }
    const put = capturePut()
    const deliver = createWebdavDeliverer({
      getConfig: () => cfg,
      isConfigured: () => true,
      loadRootKey: async () => null, // key not ready
      put,
    })
    expect(await deliver(makeIntent())).toBe('transient-fail')
    expect(put.calls).toHaveLength(0) // never downgrades to plaintext, never sends
  })
})
