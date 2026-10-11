import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RELAY_CONFIRM_MS } from '@glance-apps/sync'
import { reconcileRoster, relativeRosterPaths, syncSharedUsersViaDirectAccess, ROSTER_EDIT_KEY, _resetRosterSyncStateForTests, type RosterSyncState } from './sharedUsers'
import type { DirectAccessTransport } from '@/sync/directAccess'
import type { User } from '@/types'

const T0 = Date.parse('2026-10-11T12:00:00.000Z')
const user = (sync_id: string, name: string, updated_at: string): User => ({ id: 1, sync_id, name, updated_at }) as User
const memStorage = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
}

function fakeTransport(folder: { text: string | null; writes: string[] }, over: { supported?: boolean; available?: boolean } = {}) {
  return {
    id: 'direct-access',
    isSupported: () => over.supported ?? true,
    isAvailable: () => over.available ?? true,
    roster: {
      supported: () => true,
      read: vi.fn(async () => folder.text),
      write: vi.fn(async (_rel: string, text: string) => { folder.text = text; folder.writes.push(text); return true }),
      forget: async () => {},
    },
  } as unknown as DirectAccessTransport
}
const fresh = (): RosterSyncState => ({ lastWrittenAt: 0, previousReadAt: 0, pending: null })
const quiet = { warn: vi.fn() }

beforeEach(() => _resetRosterSyncStateForTests())

describe('reconcileRoster', () => {
  it('seeds from local when the file is absent, merges last-writer-wins by updatedAt, and waits while downloading', () => {
    expect(relativeRosterPaths(undefined)).toEqual({ dirPath: 'GLANCE/users/', filePath: 'GLANCE/users/glance-users.json' })
    expect(reconcileRoster('{"downloading":true}', [])).toBeNull()
    const local = [user('a', 'Ann', '2026-10-02T00:00:00.000Z'), user('b', 'Bob', '2026-10-01T00:00:00.000Z')]
    const remote = JSON.stringify({ version: 1, users: [{ id: 'a', name: 'Anne', updatedAt: '2026-10-03T00:00:00.000Z' }, { id: 'c', name: 'Cy', updatedAt: '2026-10-01T00:00:00.000Z' }], updated_at: 'x' })
    const r = reconcileRoster(remote, local)!
    expect(r.merged.map((u) => `${u.id}:${u.name}`).sort()).toEqual(['a:Anne', 'b:Bob', 'c:Cy'])
    expect(JSON.parse(r.body)).toMatchObject({ version: 1 })
    expect(reconcileRoster(null, local)!.merged.map((u) => u.id)).toEqual(['a', 'b'])
  })
})

describe('syncSharedUsersViaDirectAccess', () => {
  it('is null, and writes nothing, without a folder, when unreachable, while downloading, or on an error', async () => {
    const folder = { text: null as string | null, writes: [] as string[] }
    const local = [user('a', 'Ann', '2026-10-02T00:00:00.000Z')]
    expect(await syncSharedUsersViaDirectAccess('/GLANCE/users/', local, fakeTransport(folder, { supported: false }), { log: quiet })).toBeNull()
    expect(await syncSharedUsersViaDirectAccess('/GLANCE/users/', local, fakeTransport(folder, { available: false }), { log: quiet })).toBeNull()
    folder.text = '{"downloading":true}'
    expect(await syncSharedUsersViaDirectAccess('/GLANCE/users/', local, fakeTransport(folder), { log: quiet })).toBeNull()
    folder.text = '{"error":"gone"}'
    expect(await syncSharedUsersViaDirectAccess('/GLANCE/users/', local, fakeTransport(folder), { log: quiet })).toBeNull()
    expect(folder.writes).toEqual([])
  })

  it('a change made here is written at once; one that arrived by another road waits for the folder, then relays', async () => {
    const folder = { text: null as string | null, writes: [] as string[] }
    const storage = memStorage()
    let now = T0
    const st = fresh()
    const deps = { now: () => now, storage, state: st, log: quiet }
    // First writer: an edit made here (the stamp is newer than any write) seeds the roster.
    storage.setItem(ROSTER_EDIT_KEY, new Date(T0 - 1000).toISOString())
    const r1 = await syncSharedUsersViaDirectAccess('/GLANCE/users/', [user('a', 'Ann', '2026-10-02T00:00:00.000Z')], fakeTransport(folder), deps)
    expect(r1!.merged.map((u) => u.id)).toEqual(['a'])
    expect(folder.writes).toHaveLength(1)
    const t = fakeTransport(folder)
    // Nothing changed: no write.
    now += 1000
    await syncSharedUsersViaDirectAccess('/GLANCE/users/', [user('a', 'Ann', '2026-10-02T00:00:00.000Z')], t, deps)
    expect(folder.writes).toHaveLength(1)
    // A member arrives by the vault (no roster edit stamp): deferred, merged locally all the same.
    now += 1000
    const two = [user('a', 'Ann', '2026-10-02T00:00:00.000Z'), user('b', 'Bob', '2026-10-11T11:00:00.000Z')]
    const r2 = await syncSharedUsersViaDirectAccess('/GLANCE/users/', two, t, deps)
    expect(r2!.merged.map((u) => u.id).sort()).toEqual(['a', 'b'])
    expect(folder.writes).toHaveLength(1)
    now += RELAY_CONFIRM_MS - 1
    await syncSharedUsersViaDirectAccess('/GLANCE/users/', two, t, deps)
    expect(folder.writes).toHaveLength(1)
    now += 2
    await syncSharedUsersViaDirectAccess('/GLANCE/users/', two, t, deps)
    expect(folder.writes).toHaveLength(2)
    expect(JSON.parse(folder.text!).users.map((u: { id: string }) => u.id).sort()).toEqual(['a', 'b'])
    // A rename made here goes out at once.
    now += 1000
    storage.setItem(ROSTER_EDIT_KEY, new Date(now).toISOString())
    now += 10
    await syncSharedUsersViaDirectAccess('/GLANCE/users/', [two[0], user('b', 'Robert', new Date(now).toISOString())], t, deps)
    expect(folder.writes).toHaveLength(3)
    // The second device merges the file into its own list and writes nothing: the file already holds the result.
    const other = fresh()
    const r3 = await syncSharedUsersViaDirectAccess('/GLANCE/users/', [user('c', 'Cy', '2026-10-01T00:00:00.000Z')], fakeTransport(folder), { now: () => now, storage: memStorage(), state: other, log: quiet })
    expect(r3!.merged.map((u) => u.id).sort()).toEqual(['a', 'b', 'c'])
    expect(folder.writes).toHaveLength(3)   // c is new to the file, but arrived by no edit here: deferred
  })
})
