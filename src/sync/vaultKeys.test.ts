import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@glance-apps/sync', () => ({ clearDbRootKey: vi.fn(async () => {}) }))
vi.mock('./engine', () => ({ DB_CRYPTO_CONFIG: { cryptoDBName: 'lastglance-crypto' } }))
vi.mock('@/intents/vaultIntentsKeyStore', () => ({ clearVaultIntentsRootKey: vi.fn(async () => {}) }))

import { clearDbRootKey } from '@glance-apps/sync'
import { clearVaultIntentsRootKey } from '@/intents/vaultIntentsKeyStore'
import { clearCachedVaultKeys } from './vaultKeys'

describe('clearCachedVaultKeys', () => {
  beforeEach(() => {
    vi.mocked(clearDbRootKey).mockReset().mockResolvedValue(undefined)
    vi.mocked(clearVaultIntentsRootKey).mockReset().mockResolvedValue(undefined)
  })

  it('drops the shared sync root key from the DB-tier slot and the vault intents key', async () => {
    await clearCachedVaultKeys()
    expect(clearDbRootKey).toHaveBeenCalledWith({ cryptoDBName: 'lastglance-crypto' })
    expect(clearVaultIntentsRootKey).toHaveBeenCalledTimes(1)
  })

  // The recovery reloads after this resolves; a storage error must not strand
  // the user on a page that can neither clear the key nor reload.
  it('still clears the intents key and resolves when the root key clear fails', async () => {
    vi.mocked(clearDbRootKey).mockRejectedValue(new Error('IndexedDB unavailable'))
    await expect(clearCachedVaultKeys()).resolves.toBeUndefined()
    expect(clearVaultIntentsRootKey).toHaveBeenCalledTimes(1)
  })

  it('resolves when the intents key clear fails', async () => {
    vi.mocked(clearVaultIntentsRootKey).mockRejectedValue(new Error('IndexedDB unavailable'))
    await expect(clearCachedVaultKeys()).resolves.toBeUndefined()
  })
})
