import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The shell this runs in, per test: iOS with the iCloud plugin, or not. And a
// Direct Access folder the emitter and the availability check both read.
const env = vi.hoisted(() => ({ ios: false, daSupported: false, daConnected: false }))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => (env.ios ? 'ios' : 'web'),
    isNativePlatform: () => env.ios,
    isPluginAvailable: (name: string) => env.ios && name === 'ICloud',
  },
  registerPlugin: () => ({}),
}))

vi.mock('@/sync/directAccess', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/sync/directAccess')>()
  return {
    ...real,
    directAccessTransport: {
      ...real.directAccessTransport,
      isSupported: () => env.daSupported,
      isConnected: () => env.daConnected,
      getSnapshot: () => ({ ...real.directAccessTransport.getSnapshot(), supported: env.daSupported, connected: env.daConnected }),
    },
  }
})

import { anyIntentsTransportOn, intentsTransportsOn, type IntentsTransportsOn } from './intentsAvailable'
import { enabledIntentTargets } from './emitter'
import { saveIntentsConfig, DEFAULT_CONFIG } from './config'
import { getDbIntentsConfig, saveDbIntentsConfig } from './dbConfig'
import { setICloudIntentsEnabled } from './icloudIntents'
import { setVaultConfig } from '@/sync/vaultConfig'
import type { TransportName } from './outbox'

const OFF: IntentsTransportsOn = { webdav: false, vault: false, directAccess: false, icloud: false }

let store: Map<string, string>
beforeEach(() => {
  store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)) },
      removeItem: (k: string) => { store.delete(k) },
      clear: () => { store.clear() },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() { return store.size },
    },
  })
  env.ios = false
  env.daSupported = false
  env.daConnected = false
})
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage
})

// Each transport's switch, turned on the way a user turns it on.
const turnOn: Record<TransportName, () => void> = {
  webdav: () => saveIntentsConfig({ ...DEFAULT_CONFIG, enabled: true, webdavUrl: 'https://x', webdavUsername: 'u', webdavPassword: 'p' }),
  vault: () => {
    setVaultConfig({ enabled: true, vaultUrl: 'https://v', vaultToken: 't', accountId: 'a' })
    saveDbIntentsConfig({ ...getDbIntentsConfig(), enabled: true })
  },
  directAccess: () => {
    store.set('lg_direct_access_intents_enabled', 'true')
    env.daSupported = true
    env.daConnected = true
  },
  icloud: () => {
    env.ios = true
    setICloudIntentsEnabled(true)
  },
}
const ALL = Object.keys(turnOn) as TransportName[]

const onNames = (on: IntentsTransportsOn): TransportName[] => ALL.filter((t) => on[t])

describe('intents availability', () => {
  it('any one transport is enough', () => {
    expect(anyIntentsTransportOn(OFF)).toBe(false)
    for (const t of ALL) expect(anyIntentsTransportOn({ ...OFF, [t]: true })).toBe(true)
  })

  it('Direct Access counts only with its opt-in on and a folder connected', () => {
    expect(intentsTransportsOn({ supported: true, connected: true }).directAccess).toBe(false)
    store.set('lg_direct_access_intents_enabled', 'true')
    expect(intentsTransportsOn({ supported: true, connected: true }).directAccess).toBe(true)
    expect(intentsTransportsOn({ supported: true, connected: false }).directAccess).toBe(false)
    expect(intentsTransportsOn({ supported: false, connected: false }).directAccess).toBe(false)
  })

  it('iCloud counts only with its opt-in on in an iOS shell with the plugin', () => {
    env.ios = true
    expect(intentsTransportsOn().icloud).toBe(false)
    setICloudIntentsEnabled(true)
    expect(intentsTransportsOn().icloud).toBe(true)
    env.ios = false
    expect(intentsTransportsOn().icloud).toBe(false)
  })

  it('an iCloud-only setup reports available', () => {
    turnOn.icloud()
    const on = intentsTransportsOn()
    expect(on).toEqual({ ...OFF, icloud: true })
    expect(anyIntentsTransportOn(on)).toBe(true)
  })

  // The availability check and the emitter must agree on every transport: an
  // emit that would deliver with the buttons hidden is the bug this guards.
  it('covers the same transports as the emitter, one at a time and all at once', () => {
    expect(onNames(intentsTransportsOn())).toEqual([])
    expect(enabledIntentTargets()).toEqual([])
    expect(Object.keys(intentsTransportsOn()).sort()).toEqual([...ALL].sort())

    for (const t of ALL) {
      store.clear(); env.ios = false; env.daSupported = false; env.daConnected = false
      turnOn[t]()
      expect(enabledIntentTargets()).toEqual([t])
      expect(onNames(intentsTransportsOn())).toEqual([t])
    }

    for (const t of ALL) turnOn[t]()
    expect(enabledIntentTargets().sort()).toEqual([...ALL].sort())
    expect(onNames(intentsTransportsOn()).sort()).toEqual([...ALL].sort())
  })
})
