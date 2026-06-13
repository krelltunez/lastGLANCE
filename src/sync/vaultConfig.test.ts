import { describe, it, expect, beforeEach } from 'vitest'
import { getVaultConfig, setVaultConfig, isVaultEnabled } from './vaultConfig'

function installLocalStorage(): void {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  } as Storage
}

describe('vaultConfig', () => {
  beforeEach(() => { installLocalStorage() })

  it('returns null when nothing is stored', () => {
    expect(getVaultConfig()).toBeNull()
    expect(isVaultEnabled()).toBe(false)
  })

  it('saves and loads a full config round-trip', () => {
    const cfg = {
      enabled: true,
      vaultUrl: 'https://vault.glance-apps.com',
      vaultToken: 'tok_abc123',
      accountId: 'household-42',
    }
    setVaultConfig(cfg)
    expect(getVaultConfig()).toEqual(cfg)
    expect(isVaultEnabled()).toBe(true)
  })

  it('clears the config when passed null', () => {
    setVaultConfig({ enabled: true, vaultUrl: 'u', vaultToken: 't', accountId: 'a' })
    setVaultConfig(null)
    expect(getVaultConfig()).toBeNull()
    expect(isVaultEnabled()).toBe(false)
  })

  it('treats a disabled or incomplete config as not enabled', () => {
    setVaultConfig({ enabled: false, vaultUrl: 'u', vaultToken: 't', accountId: 'a' })
    expect(isVaultEnabled()).toBe(false)

    setVaultConfig({ enabled: true, vaultUrl: '', vaultToken: 't', accountId: 'a' })
    expect(isVaultEnabled()).toBe(false)
  })

  it('tolerates malformed stored JSON', () => {
    localStorage.setItem('lastglance-vault-config', '{not valid json')
    expect(getVaultConfig()).toBeNull()
  })
})
