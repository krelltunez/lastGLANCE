import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web', isNativePlatform: () => false, isPluginAvailable: () => false },
  registerPlugin: () => ({}),
}))

import { runDirectAccessCycle } from './directAccessCycle'
import { runPeopleDirectAccessCycle } from '@/people/sync/directAccessCycle'
import { mergePayloads } from './engine'
import { createICloudTransport, choresHaveRealData, getICloudSyncPref } from './icloud'
import { LOCAL_EDIT_KEY } from './localEditStamp'
import { SEED_TIMESTAMP, SEED_CHORE_SYNC_IDS } from '@/db/client'
import { emptyPeoplePayload } from '@/people/sync/types'
import type { ICloudBridge } from '@/native/icloud'
import type { DirectAccessRead } from '@/native/directAccess'
import type { SyncChore, SyncPayload } from './types'
import type { PeoplePayload, SyncPerson } from '@/people/sync/types'

// Zero-config iCloud between an iPhone and an iPad on one Apple ID: the real
// iCloud transport, the real cycles and merges, over one shared container.
// What it holds the wiring to: a device with data of its own syncs without
// being asked; a fresh install (sample chores only) facing iCloud data is asked
// before anything is restored or written; the answer is kept, and "start fresh"
// leaves iCloud alone.

const empty = (): SyncPayload => ({ chores: [], categories: [], completionEvents: [], users: [], settings: { multiUserEnabled: false }, tombstones: {} })
const chore = (id: string, name: string, updatedAt: string): SyncChore => ({ id, name, categorySyncId: 'c', sortOrder: 0, targetCadenceDays: 7, notifyWhenOverdue: false, autoScheduleToDayglance: false, preferredScheduleBehavior: null, seasonalStart: null, seasonalEnd: null, details: null, icon: undefined, assignedUserSyncIds: [], createdAt: updatedAt, updatedAt })
const sample = (): SyncPayload => ({ ...empty(), chores: [chore(SEED_CHORE_SYNC_IDS[0], 'Mop kitchen', SEED_TIMESTAMP)] })
const person = (n: number, name: string): SyncPerson => ({
  kind: 'person', id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name, nickname: null, circleSyncId: null,
  targetCadenceDays: 14, preferredChannel: 'call', details: null, archived: false, snoozedUntil: null, ownerUserSyncId: null,
  createdAt: '2026-10-24T10:00:00.000Z', updatedAt: '2026-10-24T10:00:00.000Z',
})

const memStorage = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) } }
}

function container() {
  const files = new Map<string, string>()
  const bridge: ICloudBridge = {
    available: async () => true,
    read: async (path): Promise<DirectAccessRead> => (files.has(path) ? { kind: 'text', text: files.get(path)! } : { kind: 'absent' }),
    write: async (path, text) => { files.set(path, text); return true },
    list: async () => [...files.keys()],
    remove: async (path) => files.delete(path),
    makeDir: async () => true,
    onChanged: () => () => {},
  }
  return { files, bridge }
}

function device(name: string, icloud: ReturnType<typeof container>, start: SyncPayload, people: PeoplePayload = emptyPeoplePayload()) {
  const storage = memStorage()
  const transport = createICloudTransport({ bridge: () => icloud.bridge, storage: () => storage })
  let store = start
  let peopleStore = people
  let chores = { missingSince: 0, lastWriteAt: 0 } as Parameters<typeof runDirectAccessCycle>[1]
  let peopleState = { missingSince: 0, lastWriteAt: 0 } as Parameters<typeof runDirectAccessCycle>[1]
  let now = Date.parse('2026-10-25T12:00:00.000Z')
  const common = { storage, deviceId: () => name, now: () => now, log: { warn: () => {}, error: () => {} } }
  return {
    storage, transport,
    get store() { return store },
    get people() { return peopleStore },
    edit: (s: SyncPayload) => { store = s; storage.setItem(LOCAL_EDIT_KEY, new Date(now).toISOString()) },
    tick: (ms: number) => { now += ms },
    // One pass of what useSnapshotFileSync does: inert while off, chores, then People.
    async sync() {
      if (!transport.isEnabled() || !(await transport.isAvailable())) return { chores: null, people: null }
      const c = await runDirectAccessCycle({
        transport, ...common, hasData: choresHaveRealData,
        buildPayload: async () => store, mergePayloads,
        applyPayload: async (d) => { store = d as SyncPayload },
        lastLocalEditAt: () => storage.getItem(LOCAL_EDIT_KEY),
      }, chores)
      chores = c.state
      if (c.outcome.kind === 'prompted') return { chores: c.outcome, people: null }
      vi.stubGlobal('localStorage', storage)   // the People wrapper's stamp reads localStorage
      const p = await runPeopleDirectAccessCycle({
        transport: transport.peopleFile, ...common,
        buildPayload: async () => peopleStore as never,
        applyPayload: async (d) => { peopleStore = d as PeoplePayload },
      }, peopleState)
      peopleState = p.state
      return { chores: c.outcome, people: p.outcome }
    },
  }
}

afterEach(() => { vi.unstubAllGlobals() })

describe('zero-config iCloud between two devices', () => {
  it('a device with its own data syncs without being asked, and a second such device merges', async () => {
    const icloud = container()
    const phone = device('phone', icloud, { ...empty(), chores: [chore('a', 'Water plants', '2026-10-24T09:00:00.000Z')] })
    const r1 = await phone.sync()
    expect(r1.chores).toMatchObject({ kind: 'seeded', wrote: true })
    expect(getICloudSyncPref(() => phone.storage)).toBeNull()   // never asked, still on

    const tablet = device('tablet', icloud, { ...empty(), chores: [chore('b', 'Vacuum', '2026-10-24T09:30:00.000Z')] })
    const r2 = await tablet.sync()
    expect(r2.chores).toMatchObject({ kind: 'merged', applied: true })
    expect(tablet.store.chores.map((c) => c.name).sort()).toEqual(['Vacuum', 'Water plants'])
  })

  it('a fresh install facing iCloud data is asked first, and restoring brings everything in', async () => {
    const icloud = container()
    const phone = device('phone', icloud, { ...empty(), chores: [chore('a', 'Water plants', '2026-10-24T09:00:00.000Z')] }, { ...emptyPeoplePayload(), people: [person(1, 'Maya Chen')] })
    await phone.sync()
    const before = new Map(icloud.files)

    const tablet = device('tablet', icloud, sample())   // samples only: no data of its own
    const asked = await tablet.sync()
    expect(asked.chores).toMatchObject({ kind: 'prompted' })
    expect(tablet.store.chores.map((c) => c.name)).toEqual(['Mop kitchen'])   // nothing restored yet
    expect(icloud.files).toEqual(before)                                       // and nothing written

    tablet.transport.setEnabled(true)                 // "Restore from iCloud"
    const restored = await tablet.sync()
    expect(restored.chores).toMatchObject({ kind: 'merged', applied: true })
    expect(tablet.store.chores.map((c) => c.name)).toContain('Water plants')
    expect(tablet.people.people.map((p) => p.name)).toEqual(['Maya Chen'])
  })

  it('starting fresh turns iCloud off on that device and leaves iCloud alone', async () => {
    const icloud = container()
    const phone = device('phone', icloud, { ...empty(), chores: [chore('a', 'Water plants', '2026-10-24T09:00:00.000Z')] })
    await phone.sync()
    const before = new Map(icloud.files)

    const tablet = device('tablet', icloud, sample())
    expect((await tablet.sync()).chores).toMatchObject({ kind: 'prompted' })
    tablet.transport.setEnabled(false)                // "Start fresh on this device"
    tablet.edit({ ...sample(), chores: [chore('t', 'Feed cat', '2026-10-25T12:00:00.000Z')] })
    expect(await tablet.sync()).toEqual({ chores: null, people: null })
    expect(icloud.files).toEqual(before)
    expect(tablet.store.chores.map((c) => c.name)).toEqual(['Feed cat'])
  })

  it('a fresh install with only People in iCloud is asked by the People file', async () => {
    const icloud = container()
    const phone = device('phone', icloud, sample(), { ...emptyPeoplePayload(), people: [person(1, 'Maya Chen')] })
    await phone.sync()

    const tablet = device('tablet', icloud, sample())
    const r = await tablet.sync()
    expect(r.chores).toMatchObject({ kind: 'merged' })      // samples on both sides: nothing to ask about
    expect(r.people).toMatchObject({ kind: 'prompted' })
    expect(tablet.people.people).toEqual([])
  })

  it('an edit on one device reaches the other on its next poll', async () => {
    const icloud = container()
    const phone = device('phone', icloud, { ...empty(), chores: [chore('a', 'Water plants', '2026-10-24T09:00:00.000Z')] })
    const tablet = device('tablet', icloud, { ...empty(), chores: [chore('b', 'Vacuum', '2026-10-24T09:30:00.000Z')] })
    await phone.sync(); await tablet.sync()
    phone.tick(60_000)
    await phone.sync()

    tablet.tick(120_000)
    tablet.edit({ ...tablet.store, chores: [...tablet.store.chores, chore('c', 'Mow lawn', '2026-10-25T12:02:00.000Z')] })
    expect((await tablet.sync()).chores).toMatchObject({ wrote: true })
    phone.tick(180_000)
    await phone.sync()
    expect(phone.store.chores.map((c) => c.name).sort()).toEqual(['Mow lawn', 'Vacuum', 'Water plants'])
  })
})
