import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'

// Both vault engines run the one-time re-push (launcherWritesRepair.ts) inside
// their own cycle: the chore engine over its four tables, the People engine
// over its four. The sync client is a fake whose cycles succeed and record what
// was marked when each ran.

const cycles: Record<string, string[][]> = {}
vi.mock('@glance-apps/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@glance-apps/sync')>()
  return {
    ...actual,
    createDbSyncEngine: (config: { appId: string }) => {
      const marked = new Set<string>()
      let lastSynced: string | null = null
      let n = 0
      cycles[config.appId] = []
      return {
        markDirty: (id: string) => { marked.add(id) },
        dbSyncCycle: async () => {
          cycles[config.appId].push([...marked])
          lastSynced = `2026-11-05T00:00:0${++n}.000Z`
          return { applied: 0, skipped: 0, skippedEntityIds: [] }
        },
        getHighWaterMark: () => 1,
        setHighWaterMark: () => {},
        getLastSynced: () => lastSynced,
      }
    },
  }
})

class FakeStorage {
  private store = new Map<string, string>()
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null }
  setItem(k: string, v: string): void { this.store.set(k, String(v)) }
  removeItem(k: string): void { this.store.delete(k) }
  clear(): void { this.store.clear() }
  key(i: number): string | null { return Array.from(this.store.keys())[i] ?? null }
  get length(): number { return this.store.size }
}

describe('the vault engines run the launcher-writes re-push', () => {
  it('each marks its rows changed since 26 October once, after a successful cycle, and pushes them', async () => {
    const g = globalThis as Record<string, unknown>
    g.localStorage = new FakeStorage()
    g.window = globalThis
    localStorage.setItem('lastglance-vault-config', JSON.stringify({
      enabled: true, vaultUrl: 'https://vault.example', vaultToken: 't', accountId: 'acct',
    }))
    const { db } = await import('@/db/client')
    await db.open()
    await db.completionEvents.bulkAdd([
      { chore_id: 1, completed_at: '2026-11-03T18:00:00.000Z', updated_at: '2026-11-03T18:00:00.000Z', note: null, source: 'manual', completed_by_user_sync_id: null, sync_id: 'event-new' },
      { chore_id: 1, completed_at: '2026-10-01T18:00:00.000Z', updated_at: '2026-10-01T18:00:00.000Z', note: null, source: 'manual', completed_by_user_sync_id: null, sync_id: 'event-old' },
    ] as never)
    await db.interactions.bulkAdd([
      { sync_id: 'call-new', person_sync_ids: ['p'], occurred_at: '2026-11-03T18:00:00.000Z', channel: 'call', direction: null, note: null, source: 'intent', updated_at: '2026-11-03T18:00:00.000Z' },
      { sync_id: 'call-old', person_sync_ids: ['p'], occurred_at: '2026-10-01T18:00:00.000Z', channel: 'call', direction: null, note: null, source: 'intent', updated_at: '2026-10-01T18:00:00.000Z' },
    ] as never)

    const { createDbEngine } = await import('./dbEngine')
    const { createPeopleDbEngine } = await import('@/people/sync/dbEngine')
    for (const [engine, app, fresh, old] of [
      [createDbEngine()!, 'lastglance', 'event-new', 'event-old'],
      [createPeopleDbEngine()!, 'lastglance-people', 'call-new', 'call-old'],
    ] as const) {
      await engine.dbSyncCycle()
      // The cycle, then the marking, then a second cycle that pushes it.
      expect(cycles[app].length).toBe(2)
      expect(cycles[app][0]).not.toContain(fresh)
      expect(cycles[app][1]).toContain(fresh)
      expect(cycles[app][1]).not.toContain(old)
      // Once only.
      await engine.dbSyncCycle()
      expect(cycles[app].length).toBe(3)
    }
  })
})
