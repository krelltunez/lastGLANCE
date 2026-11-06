import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// People must never reach an older build. These tests pin the two roads that
// guarantee it: People ride their own vault app and their own sync file, and
// never the chore payload or the lastglance app.

const captured: { db?: Record<string, unknown>; file?: Record<string, unknown> } = {}
const fakeCycle = vi.fn(async () => ({ applied: 0, skipped: 0, skippedEntityIds: [] }))

vi.mock('@glance-apps/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@glance-apps/sync')>()
  return {
    ...actual,
    createDbSyncEngine: (config: Record<string, unknown>) => {
      captured.db = config
      return { dbSyncCycle: fakeCycle, markDirty: vi.fn(), getHighWaterMark: () => 1, getLastSynced: () => null }
    },
    createSyncEngine: (config: Record<string, unknown>) => {
      captured.file = config
      let cfg: unknown = null
      return {
        getConfig: () => cfg,
        setConfig: (c: unknown) => { cfg = c },
        sync: vi.fn(async () => {}),
      }
    },
  }
})

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
installLocalStorage()

const { setVaultConfig } = await import('@/sync/vaultConfig')
const { createPeopleDbEngine, isUnknownAppError, PEOPLE_VAULT_APP } = await import('./dbEngine')
const { createPeopleFileEngine, PEOPLE_SYNC_FILENAME } = await import('./fileEngine')
const { mergePayloads } = await import('@/sync/engine')
const { PEOPLE_VAULT_SYNC_KEY } = await import('../vaultSync')

beforeEach(() => {
  localStorage.clear()
  captured.db = undefined
  captured.file = undefined
  fakeCycle.mockClear()
  setVaultConfig({ enabled: true, vaultUrl: 'https://vault.example', vaultToken: 't', accountId: 'acct' })
})

describe('People vault road', () => {
  it('syncs the lastglance-people app with its own device id and storage prefix', () => {
    localStorage.setItem('lastglance-device-id', 'dev-1')
    expect(createPeopleDbEngine()).not.toBeNull()
    expect(PEOPLE_VAULT_APP).toBe('lastglance-people')
    expect(captured.db).toMatchObject({
      vaultApp: 'lastglance-people',
      appId: 'lastglance-people',
      storageKeyPrefix: 'lastglance-people',
      deviceId: 'dev-1-people',
    })
  })

  it('stays off when the user keeps People off the shared vault', () => {
    localStorage.setItem(PEOPLE_VAULT_SYNC_KEY, 'false')
    expect(createPeopleDbEngine()).toBeNull()
  })

  it('stands down after a vault that does not know the app answers 400', async () => {
    const onUnsupported = vi.fn()
    const onError = vi.fn()
    const engine = createPeopleDbEngine({ onUnsupported, onError })!
    await engine.dbSyncCycle()
    expect(fakeCycle).toHaveBeenCalledTimes(1)

    const report = captured.db!.onError as (m: string | null, c: string | null) => void
    report('list failed: 400', null)
    report('list failed: 400', null)
    expect(onUnsupported).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()

    await engine.dbSyncCycle()
    expect(fakeCycle).toHaveBeenCalledTimes(1)
  })

  it('recognizes only the unknown-app refusal', () => {
    expect(isUnknownAppError('batch upsert failed: 400')).toBe(true)
    expect(isUnknownAppError('unknown app')).toBe(true)
    expect(isUnknownAppError('list failed: 401')).toBe(false)
    expect(isUnknownAppError('list failed: 4000')).toBe(false)
    expect(isUnknownAppError(null)).toBe(false)
  })
})

describe('People file road', () => {
  it('uses its own file and app id, and mirrors the chore sync config', async () => {
    const mainCfg = { enabled: true, provider: 'webdav', webdavUrl: 'https://dav.example' }
    const main = { getConfig: () => mainCfg } as unknown as import('@glance-apps/sync').SyncEngine
    const engine = createPeopleFileEngine(undefined, main)
    expect(PEOPLE_SYNC_FILENAME).toBe('lastglance-people.json')
    expect(captured.file).toMatchObject({
      syncFilename: 'lastglance-people.json',
      appId: 'lastglance-people',
      storageKeyPrefix: 'lastglance-people',
    })
    await engine.sync()
    expect(engine.getConfig()).toEqual(mainCfg)
  })

  it('the chore payload merge drops arrays it does not know, which is why People need their own file', () => {
    const withPeople = {
      chores: [], categories: [], completionEvents: [], users: [],
      settings: { multiUserEnabled: false }, tombstones: {},
      people: [{ id: 'aaaaaaaa-0000-4000-8000-000000000001' }],
    }
    const { data } = mergePayloads(withPeople, withPeople)
    expect(data).not.toHaveProperty('people')
  })
})
