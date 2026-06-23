import 'fake-indexeddb/auto'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import { deriveIntentsRootKey } from '@glance-apps/intents'
import { ensureVaultIntentsKey, VaultSaltMissingError } from './setupVaultIntentsEncryption'
import {
  loadVaultIntentsRootKey,
  storeVaultIntentsRootKey,
  clearVaultIntentsRootKey,
  __resetVaultIntentsKeyCacheForTests,
} from './vaultIntentsKeyStore'

beforeAll(() => {
  if (!(globalThis as { crypto?: Crypto }).crypto) {
    ;(globalThis as { crypto?: Crypto }).crypto = webcrypto as unknown as Crypto
  }
})

beforeEach(async () => {
  await clearVaultIntentsRootKey()
  __resetVaultIntentsKeyCacheForTests()
})

// A real derive+cache that mirrors setupVaultIntentsEncryption minus the network
// salt fetch: derive from (passphrase, fixed vault salt) and cache in the slot.
const VAULT_SALT = new Uint8Array(16).fill(9)
function realDeriveAndCache() {
  const calls: string[] = []
  const derive = async (passphrase: string) => {
    calls.push(passphrase)
    const rootKey = await deriveIntentsRootKey(passphrase, VAULT_SALT)
    await storeVaultIntentsRootKey(rootKey)
  }
  return Object.assign(derive, { calls })
}

describe('ensureVaultIntentsKey (enable-time orchestration)', () => {
  // enable WITH passphrase: derives + caches a vault key; prompt not shown.
  it('derives and caches a vault key when the passphrase is available', async () => {
    const derive = realDeriveAndCache()
    const prompt = vi.fn(async () => null as string | null)

    const result = await ensureVaultIntentsKey({
      loadCachedKey: loadVaultIntentsRootKey,
      getPassphrase: () => 'sync-pass',
      promptForPassphrase: prompt,
      derive,
    })

    expect(result).toEqual({ status: 'ready' })
    expect(prompt).not.toHaveBeenCalled() // passphrase present -> no prompt
    expect(derive.calls).toEqual(['sync-pass'])

    // The key is genuinely cached and loadable (survives a fresh load).
    __resetVaultIntentsKeyCacheForTests()
    expect(await loadVaultIntentsRootKey()).not.toBeNull()
  })

  // enable WITHOUT passphrase: triggers the prompt; entry derives + caches.
  it('prompts for the passphrase when none is loaded, then derives', async () => {
    const derive = realDeriveAndCache()
    const prompt = vi.fn(async () => 'typed-pass' as string | null)

    const result = await ensureVaultIntentsKey({
      loadCachedKey: loadVaultIntentsRootKey,
      getPassphrase: () => null, // not unlocked
      promptForPassphrase: prompt,
      derive,
    })

    expect(prompt).toHaveBeenCalledTimes(1) // prompt was triggered
    expect(result).toEqual({ status: 'ready' })
    expect(derive.calls).toEqual(['typed-pass'])
    __resetVaultIntentsKeyCacheForTests()
    expect(await loadVaultIntentsRootKey()).not.toBeNull()
  })

  // CANCEL: leaves it disabled, no key cached, derive never runs.
  it('returns cancelled (no key cached) when the passphrase prompt is dismissed', async () => {
    const derive = realDeriveAndCache()
    const prompt = vi.fn(async () => null as string | null) // user cancels

    const result = await ensureVaultIntentsKey({
      loadCachedKey: loadVaultIntentsRootKey,
      getPassphrase: () => null,
      promptForPassphrase: prompt,
      derive,
    })

    expect(result).toEqual({ status: 'cancelled' })
    expect(derive.calls).toEqual([]) // never derived
    __resetVaultIntentsKeyCacheForTests()
    expect(await loadVaultIntentsRootKey()).toBeNull() // nothing cached
  })

  // already cached: no prompt, no re-derive.
  it('does nothing when a vault key is already cached', async () => {
    // Pre-cache a key.
    await storeVaultIntentsRootKey(await deriveIntentsRootKey('pre', VAULT_SALT))
    const derive = realDeriveAndCache()
    const prompt = vi.fn(async () => null as string | null)

    const result = await ensureVaultIntentsKey({
      loadCachedKey: loadVaultIntentsRootKey,
      getPassphrase: () => 'sync-pass',
      promptForPassphrase: prompt,
      derive,
    })

    expect(result).toEqual({ status: 'ready' })
    expect(prompt).not.toHaveBeenCalled()
    expect(derive.calls).toEqual([]) // not re-derived
  })

  // derive failure (e.g. getSalt null -> VaultSaltMissingError) surfaces as error.
  it('returns error (no key cached) when derivation fails', async () => {
    const derive = vi.fn(async () => { throw new VaultSaltMissingError() })

    const result = await ensureVaultIntentsKey({
      loadCachedKey: loadVaultIntentsRootKey,
      getPassphrase: () => 'sync-pass',
      promptForPassphrase: async () => null,
      derive,
    })

    expect(result.status).toBe('error')
    if (result.status === 'error') expect(result.error).toBeInstanceOf(VaultSaltMissingError)
    __resetVaultIntentsKeyCacheForTests()
    expect(await loadVaultIntentsRootKey()).toBeNull()
  })
})
