import { describe, it, expect, vi } from 'vitest'

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web', isNativePlatform: () => false, isPluginAvailable: () => false },
  registerPlugin: () => ({}),
}))

import {
  createICloudTransport, getICloudSyncPref, isICloudSyncEnabled, setICloudSyncEnabled, choresHaveRealData, realChoreCount,
  ICLOUD_SYNC_PREF_KEY, ICLOUD_LAST_SYNCED_KEY, ICLOUD_PEOPLE_LAST_SYNCED_KEY, ICLOUD_DOWNLOAD_GRACE_MS,
} from './icloud'
import { createICloudBridge, type ICloudBridge, type ICloudPluginType } from '@/native/icloud'
import { SEED_TIMESTAMP, SEED_CHORE_SYNC_IDS, SEED_CAT_SYNC_IDS } from '@/db/client'
import type { DirectAccessRead } from '@/native/directAccess'

const memStorage = () => {
  const m = new Map<string, string>()
  const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) } }
  return () => s
}

/** An iCloud container as a map of paths, with a download state per path. */
function fakeICloud() {
  const files = new Map<string, string>()
  const stale = new Map<string, string>()
  const downloading = new Set<string>()
  let available = true
  const writes: { path: string; atomic: boolean; container: string }[] = []
  const bridge: ICloudBridge = {
    available: async () => available,
    read: async (path, { allowStale = false } = {}): Promise<DirectAccessRead> => {
      if (downloading.has(path)) {
        if (allowStale && stale.has(path)) return { kind: 'text', text: stale.get(path)! }
        return { kind: 'downloading' }
      }
      return files.has(path) ? { kind: 'text', text: files.get(path)! } : { kind: 'absent' }
    },
    write: async (path, text, { atomic = false, container = 'own' } = {}) => { files.set(path, text); writes.push({ path, atomic, container }); return true },
    list: async () => [...files.keys()],
    remove: async (path) => files.delete(path),
    makeDir: async () => true,
    onChanged: () => () => {},
  }
  return {
    bridge, files, writes,
    setAvailable: (v: boolean) => { available = v },
    stall: (path: string, lastDownloaded?: string) => { downloading.add(path); if (lastDownloaded) stale.set(path, lastDownloaded) },
    land: (path: string) => { downloading.delete(path) },
  }
}

describe('the iCloud preference', () => {
  it('is tri-state: absent means ON and undecided', () => {
    const storage = memStorage()
    expect(getICloudSyncPref(storage)).toBeNull()
    expect(isICloudSyncEnabled(storage)).toBe(true)          // zero-config
    setICloudSyncEnabled(false, storage)
    expect(getICloudSyncPref(storage)).toBe('false')
    expect(isICloudSyncEnabled(storage)).toBe(false)
    setICloudSyncEnabled(true, storage)
    expect(getICloudSyncPref(storage)).toBe('true')
    storage()!.setItem(ICLOUD_SYNC_PREF_KEY, 'nonsense')
    expect(getICloudSyncPref(storage)).toBeNull()
  })
})

describe('real data leaves the sample chores out', () => {
  const seedChore = { id: SEED_CHORE_SYNC_IDS[0], updatedAt: SEED_TIMESTAMP }
  const seedCat = { id: SEED_CAT_SYNC_IDS[0], updatedAt: SEED_TIMESTAMP }

  it('a fresh install (samples only) holds no real data', () => {
    expect(choresHaveRealData({ chores: [seedChore], categories: [seedCat], completionEvents: [] })).toBe(false)
    expect(realChoreCount({ chores: [seedChore] })).toBe(0)
  })

  it('an edited sample, a chore of the user\'s own or any completion is real', () => {
    expect(choresHaveRealData({ chores: [{ ...seedChore, updatedAt: '2026-10-25T00:00:00.000Z' }] })).toBe(true)
    expect(choresHaveRealData({ chores: [seedChore, { id: 'x', updatedAt: '2026-10-25T00:00:00.000Z' }] })).toBe(true)
    expect(realChoreCount({ chores: [seedChore, { id: 'x', updatedAt: '2026-10-25T00:00:00.000Z' }] })).toBe(1)
    expect(choresHaveRealData({ chores: [seedChore], completionEvents: [{ id: 'e' }] })).toBe(true)
    expect(choresHaveRealData(null)).toBe(false)
  })
})

describe('the iCloud transport', () => {
  it('is available only with the plugin, the switch on and iCloud reachable', async () => {
    const f = fakeICloud()
    const storage = memStorage()
    expect(await createICloudTransport({ bridge: () => null, storage }).isAvailable()).toBe(false)
    const t = createICloudTransport({ bridge: () => f.bridge, storage })
    expect(t.isSupported()).toBe(true)
    expect(await t.isAvailable()).toBe(true)
    f.setAvailable(false)
    expect(await t.isAvailable()).toBe(false)               // signed out, iCloud Drive off
    f.setAvailable(true)
    t.setEnabled(false)
    expect(await t.isAvailable()).toBe(false)               // off on this device: inert
    expect(await t.peopleFile.isAvailable()).toBe(false)
  })

  it('is plaintext, reseeds an unreadable envelope, and asks first only until decided', () => {
    const storage = memStorage()
    const t = createICloudTransport({ bridge: () => fakeICloud().bridge, storage })
    expect(t.encryptsWrites()).toBe(false)
    expect(t.allowsPlaintextReseed).toBe(true)
    expect(t.firstRunDecided()).toBe(false)
    t.setEnabled(true)
    expect(t.firstRunDecided()).toBe(true)
    expect(t.peopleFile.firstRunDecided()).toBe(true)
  })

  it('two files, each with its own seed-guard stamp, written atomically in the own container', async () => {
    const f = fakeICloud()
    const t = createICloudTransport({ bridge: () => f.bridge, storage: memStorage() })
    expect(t.lastSyncedKey).toBe(ICLOUD_LAST_SYNCED_KEY)
    expect(t.peopleFile.lastSyncedKey).toBe(ICLOUD_PEOPLE_LAST_SYNCED_KEY)
    expect(await t.read()).toBeNull()                       // absent: the cycle seeds it
    await t.write('{"chores":1}')
    await t.peopleFile.write('{"people":1}')
    expect(f.files.get('lastglance-sync.json')).toBe('{"chores":1}')
    expect(f.files.get('lastglance-people.json')).toBe('{"people":1}')
    expect(f.writes.every((w) => w.atomic && w.container === 'own')).toBe(true)
  })

  it('a stalled download is waited out, then read from the last downloaded copy', async () => {
    const f = fakeICloud()
    let now = 0
    const t = createICloudTransport({ bridge: () => f.bridge, storage: memStorage(), now: () => now, log: { warn: () => {} } })
    f.stall('lastglance-sync.json', '{"old":true}')
    expect(await t.read()).toBe('{"downloading":true}')
    now += ICLOUD_DOWNLOAD_GRACE_MS - 1
    expect(await t.read()).toBe('{"downloading":true}')
    now += 2
    expect(await t.read()).toBe('{"old":true}')              // past the window: merge into what we have
    f.land('lastglance-sync.json')
    f.files.set('lastglance-sync.json', '{"new":true}')
    expect(await t.read()).toBe('{"new":true}')
    f.stall('lastglance-sync.json', '{"old":true}')
    expect(await t.read()).toBe('{"downloading":true}')      // the clock restarted after a real read
  })

  it('a stall with no bytes on the device keeps waiting', async () => {
    const f = fakeICloud()
    let now = 0
    const t = createICloudTransport({ bridge: () => f.bridge, storage: memStorage(), now: () => now })
    f.stall('lastglance-people.json')
    expect(await t.peopleFile.read()).toBe('{"downloading":true}')
    now += ICLOUD_DOWNLOAD_GRACE_MS + 1
    expect(await t.peopleFile.read()).toBe('{"downloading":true}')
  })
})

describe('the iCloud bridge', () => {
  const plugin = (over: Partial<ICloudPluginType> = {}): ICloudPluginType => ({
    available: vi.fn(async () => ({ available: true })),
    readFile: vi.fn(async () => ({ kind: 'text' as const, text: 'x' })),
    writeFile: vi.fn(async () => ({ ok: true })),
    listFiles: vi.fn(async () => ({ names: ['a.json'] })),
    deleteFile: vi.fn(async () => ({ ok: true })),
    makeDir: vi.fn(async () => ({ ok: true })),
    addListener: vi.fn(async () => ({ remove: async () => {} })),
    ...over,
  })

  it('passes the container, the stale flag and the atomic flag through', async () => {
    const p = plugin()
    const b = createICloudBridge(p)
    await b.read('GLANCE/events/x.json', { container: 'dayglance', allowStale: true })
    expect(p.readFile).toHaveBeenCalledWith({ path: 'GLANCE/events/x.json', container: 'dayglance', allowStale: true })
    await b.write('lastglance-sync.json', 't', { atomic: true })
    expect(p.writeFile).toHaveBeenCalledWith({ path: 'lastglance-sync.json', text: 't', container: 'own', atomic: true })
    expect(await b.list('GLANCE/events/', 'dayglance')).toEqual(['a.json'])
  })

  it('answers every failure rather than throwing', async () => {
    const boom = async () => { throw new Error('nope') }
    const b = createICloudBridge(plugin({ available: boom, readFile: boom, writeFile: boom, listFiles: boom, deleteFile: boom, makeDir: boom }))
    expect(await b.available()).toBe(false)
    expect(await b.read('x')).toEqual({ kind: 'error', error: 'nope' })
    expect(await b.write('x', 'y')).toBe(false)
    expect(await b.list('x')).toBeNull()
    expect(await b.remove('x')).toBe(false)
    expect(await b.makeDir('x')).toBe(false)
    const odd = createICloudBridge(plugin({ readFile: vi.fn(async () => ({} as never)), listFiles: vi.fn(async () => ({ names: null })) }))
    expect(await odd.read('x')).toEqual({ kind: 'error', error: 'bad answer from the shell' })
    expect(await odd.list('x')).toBeNull()                    // iCloud away
  })
})
