import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

function desktop(secureStorage: boolean) {
  const items = new Map<string, string>()
  const secureStore = {
    get: vi.fn(async ({ key }: { key: string }) => ({ value: items.get(key) ?? null })),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => { items.set(key, value) }),
    delete: vi.fn(async ({ key }: { key: string }) => { items.delete(key) }),
  }
  vi.stubGlobal('window', {
    lastGlanceDesktop: {
      info: { platform: 'linux', version: '3.0.1', isMAS: false, secureStorage },
      shell: { setMenuLabels: () => {}, setTheme: () => {}, exitFullscreen: () => {} },
      secureStore,
    },
  })
  return secureStore
}

describe('secure store on the desktop', () => {
  it('uses the main process store where the OS protects it', async () => {
    const store = desktop(true)
    const { isSecureStoreAvailable, secureGet, secureSet, secureDelete } = await import('./secureStore')
    expect(isSecureStoreAvailable).toBe(true)
    await secureSet('lastglance-vault-config', 'token')
    expect(await secureGet('lastglance-vault-config')).toBe('token')
    await secureDelete('lastglance-vault-config')
    expect(await secureGet('lastglance-vault-config')).toBeNull()
    expect(store.set).toHaveBeenCalledWith({ key: 'lastglance-vault-config', value: 'token' })
  })

  it('keeps the web storage where it would not (Linux without a keyring)', async () => {
    desktop(false)
    const { isSecureStoreAvailable } = await import('./secureStore')
    expect(isSecureStoreAvailable).toBe(false)
  })
})
