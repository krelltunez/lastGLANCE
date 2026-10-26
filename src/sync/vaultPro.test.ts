import { describe, it, expect, vi, beforeEach } from 'vitest'

// The default key clearers touch IndexedDB / the Keystore; every connect test
// injects its own, and these mocks keep the imports light under node.
vi.mock('@glance-apps/sync', () => ({ clearDbRootKey: vi.fn(async () => {}) }))
vi.mock('./engine', () => ({ DB_CRYPTO_CONFIG: { cryptoDBName: 'test' } }))
vi.mock('@/intents/vaultIntentsKeyStore', () => ({ clearVaultIntentsRootKey: vi.fn(async () => {}) }))
vi.mock('@/sync/nativeHttp', () => ({ isNativePlatform: false, nativeHttpFetch: vi.fn() }))
vi.mock('./deviceId', () => ({ getDeviceId: () => 'device-1' }))

import { enrollWithAccountKey, connectVaultPro, VaultProEnrollError, type EnrollPost } from './vaultPro'
import { PRO_VAULT_URL, getVaultConfig, setVaultConfig, isProConnection, isVaultEnabled } from './vaultConfig'
import { getDbIntentsConfig, isDbIntentsEnabled, saveDbIntentsConfig } from '@/intents/dbConfig'

function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  } as Storage
  return store
}

const enrolled = (credential = 'cred-1', accountId = 'acct-daniel'): EnrollPost =>
  vi.fn(async () => ({ status: 201, body: JSON.stringify({ credentialId: 'c1', credential, accountId, deviceId: 'device-1' }) }))

const answering = (status: number, body = '{}'): EnrollPost => vi.fn(async () => ({ status, body }))

describe('enrollWithAccountKey', () => {
  it('posts the key and device id to the Pro /enroll and returns the credential and account', async () => {
    const post = enrolled()
    const out = await enrollWithAccountKey('  gvk_abc  ', { post })
    expect(out).toEqual({ credential: 'cred-1', accountId: 'acct-daniel' })
    expect(post).toHaveBeenCalledWith(`${PRO_VAULT_URL}/enroll`, JSON.stringify({ accountKey: 'gvk_abc', deviceId: 'device-1' }))
  })

  it.each([401, 403])('reports a %i as a rejected key', async (status) => {
    await expect(enrollWithAccountKey('gvk_bad', { post: answering(status) }))
      .rejects.toMatchObject({ code: 'KEY_REJECTED', status })
  })

  it('reports a server without /enroll as unavailable', async () => {
    await expect(enrollWithAccountKey('gvk', { post: answering(404) })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('reports no response as unavailable', async () => {
    const post: EnrollPost = async () => { throw new TypeError('Failed to fetch') }
    await expect(enrollWithAccountKey('gvk', { post })).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  it('reports other statuses and a reply without a credential as server errors', async () => {
    await expect(enrollWithAccountKey('gvk', { post: answering(500) })).rejects.toMatchObject({ code: 'SERVER_ERROR', status: 500 })
    await expect(enrollWithAccountKey('gvk', { post: answering(201, '{"accountId":"a"}') })).rejects.toMatchObject({ code: 'SERVER_ERROR' })
    await expect(enrollWithAccountKey('gvk', { post: answering(201, 'not json') })).rejects.toMatchObject({ code: 'SERVER_ERROR' })
  })

  it('sends nothing for an empty key', async () => {
    const post = enrolled()
    await expect(enrollWithAccountKey('   ', { post })).rejects.toBeInstanceOf(VaultProEnrollError)
    expect(post).not.toHaveBeenCalled()
  })
})

describe('connectVaultPro', () => {
  let store: Map<string, string>
  beforeEach(() => { store = installLocalStorage() })

  it('stores the Pro connection, never the key, and turns on sync and intents', async () => {
    const clearVaultKeys = vi.fn(async () => {})
    await connectVaultPro('gvk_secret', { post: enrolled(), clearVaultKeys })

    expect(getVaultConfig()).toEqual({ enabled: true, vaultUrl: PRO_VAULT_URL, vaultToken: 'cred-1', accountId: 'acct-daniel', pro: true })
    expect(isProConnection(getVaultConfig())).toBe(true)
    expect(isVaultEnabled()).toBe(true)
    expect(getDbIntentsConfig().enabled).toBe(true)
    expect(isDbIntentsEnabled()).toBe(true)
    expect([...store.values()].some(v => v.includes('gvk_secret'))).toBe(false)
  })

  it('leaves multi-user and People-on-the-vault alone', async () => {
    store.set('lg-people-vault-sync', 'false')
    const before = new Map(store)
    await connectVaultPro('gvk', { post: enrolled(), clearVaultKeys: async () => {} })
    expect(store.get('lg-people-vault-sync')).toBe('false')
    const added = [...store.keys()].filter(k => !before.has(k)).sort()
    expect(added).toEqual(['lastglance-vault-config', 'lg_db_intents_config'])
  })

  it('keeps the intents TTL and poll cadence when enabling intents', async () => {
    saveDbIntentsConfig({ enabled: false, ttlMs: 1234, pollIntervalMinutes: 7 })
    await connectVaultPro('gvk', { post: enrolled(), clearVaultKeys: async () => {} })
    expect(getDbIntentsConfig()).toEqual({ enabled: true, ttlMs: 1234, pollIntervalMinutes: 7 })
  })

  it('stores nothing when enrollment fails', async () => {
    const prev = { enabled: true, vaultUrl: 'https://self.example', vaultToken: 't', accountId: 'home' }
    setVaultConfig(prev)
    store.set('lastglance-db-sync-hwm', '42')
    await expect(connectVaultPro('gvk_bad', { post: answering(401), clearVaultKeys: async () => {} }))
      .rejects.toMatchObject({ code: 'KEY_REJECTED' })
    expect(getVaultConfig()).toEqual(prev)
    expect(getDbIntentsConfig().enabled).toBe(false)
    expect(store.get('lastglance-db-sync-hwm')).toBe('42')
  })

  it('starts clean when moving from another vault: cursors reset and cached keys cleared', async () => {
    setVaultConfig({ enabled: true, vaultUrl: 'https://self.example', vaultToken: 't', accountId: 'home' })
    store.set('lastglance-db-sync-hwm', '42')
    store.set('lastglance-device-id', 'device-1')
    const clearVaultKeys = vi.fn(async () => {})
    await connectVaultPro('gvk', { post: enrolled(), clearVaultKeys })
    expect(store.has('lastglance-db-sync-hwm')).toBe(false)
    expect(store.get('lastglance-device-id')).toBe('device-1')
    expect(clearVaultKeys).toHaveBeenCalledOnce()
  })

  it('starts clean on a device with no connection, in case keys linger from an old one', async () => {
    const clearVaultKeys = vi.fn(async () => {})
    await connectVaultPro('gvk', { post: enrolled(), clearVaultKeys })
    expect(clearVaultKeys).toHaveBeenCalledOnce()
  })

  it('a new key for the same account rotates the credential and keeps cursors and keys', async () => {
    setVaultConfig({ enabled: true, vaultUrl: PRO_VAULT_URL, vaultToken: 'old', accountId: 'acct-daniel', pro: true })
    store.set('lastglance-db-sync-hwm', '42')
    store.set('lastglance-db-sync-credential-halt', '1')
    const clearVaultKeys = vi.fn(async () => {})
    await connectVaultPro('gvk_new', { post: enrolled('cred-2'), clearVaultKeys })
    expect(getVaultConfig()?.vaultToken).toBe('cred-2')
    expect(store.get('lastglance-db-sync-hwm')).toBe('42')
    expect(store.has('lastglance-db-sync-credential-halt')).toBe(false)
    expect(clearVaultKeys).not.toHaveBeenCalled()
  })
})

describe('vault config pro flag', () => {
  beforeEach(() => { installLocalStorage() })

  it('reads a self-hosted config without a pro flag', () => {
    const cfg = { enabled: true, vaultUrl: 'u', vaultToken: 't', accountId: 'a' }
    setVaultConfig(cfg)
    expect(getVaultConfig()).toEqual(cfg)
    expect(isProConnection(getVaultConfig())).toBe(false)
  })
})
