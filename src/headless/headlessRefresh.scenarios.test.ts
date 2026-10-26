import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The headless refresh end to end, against the real engines, the real Dexie
// data layer and the real snapshot builder: credentials come out of the shell's
// secure store, the WebDAV file comes over the shell's HTTP, the merge lands in
// IndexedDB, and the snapshot the launcher reads goes back through the shell.
// The shell is a fake HeadlessBridge that records every method looked up on it,
// so the run is also held to the allowlist (HEADLESS_BRIDGE_METHODS).

class FakeStorage {
  private store = new Map<string, string>()
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null }
  setItem(k: string, v: string): void { this.store.set(k, String(v)) }
  removeItem(k: string): void { this.store.delete(k) }
  clear(): void { this.store.clear() }
  key(i: number): string | null { return Array.from(this.store.keys())[i] ?? null }
  get length(): number { return this.store.size }
}

const DAV = 'https://dav.example/remote'
const NOW = '2026-10-22T12:00:00.000Z'

interface Shell {
  bridge: Record<string, unknown>
  looked: Set<string>
  secure: Map<string, string>
  files: Map<string, { body: string; etag: string }>
  requests: string[]
  snapshots: string[]
  heartbeats: string[]
  done: string[]
  abort: { value: boolean }
  offline: { value: boolean }
  // The launcher queue, taken as the shell takes it (LauncherWriteQueue).
  queue: { value: Record<string, unknown>[] }
  acked: string[]
}

function fakeShell(): Shell {
  const secure = new Map<string, string>()
  const files = new Map<string, { body: string; etag: string }>()
  const requests: string[] = []
  const snapshots: string[] = []
  const heartbeats: string[] = []
  const done: string[] = []
  const abort = { value: false }
  const offline = { value: false }
  const queue = { value: [] as Record<string, unknown>[] }
  const acked: string[] = []
  let etagSeq = 0

  const reply = (id: string, result: unknown) =>
    setTimeout(() => (globalThis as { __lgHeadlessHttpDone?: (m: unknown) => void }).__lgHeadlessHttpDone?.({ id, result }), 0)

  const methods: Record<string, unknown> = {
    secureGet: (key: string) => JSON.stringify({ value: secure.get(key) ?? null }),
    secureSet: (key: string, value: string) => { secure.set(key, value); return true },
    secureDelete: (key: string) => { secure.delete(key) },
    httpRequestAsync: (id: string, method: string, url: string, headersJson: string, body: string | null) => {
      requests.push(`${method} ${url}`)
      if (offline.value) return reply(id, { error: 'Unable to resolve host' })
      const headers = JSON.parse(headersJson) as Record<string, string>
      if (method === 'GET') {
        const f = files.get(url)
        return reply(id, f ? { status: 200, body: f.body, headers: { etag: f.etag } } : { status: 404, body: '', headers: {} })
      }
      if (method === 'PUT') {
        const ifMatch = Object.entries(headers).find(([k]) => k.toLowerCase() === 'if-match')?.[1]
        if (ifMatch && files.get(url)?.etag !== ifMatch) return reply(id, { status: 412, body: '', headers: {} })
        const etag = `"e${++etagSeq}"`
        files.set(url, { body: body ?? '', etag })
        return reply(id, { status: 201, body: '', headers: { etag } })
      }
      return reply(id, { status: method === 'PROPFIND' ? 207 : 201, body: '', headers: {} })
    },
    updateLauncherSnapshot: (json: string) => { snapshots.push(json) },
    touchLauncherHeartbeat: (json: string) => { heartbeats.push(json) },
    takeLauncherIntents: () => {
      const all = JSON.stringify(queue.value)
      queue.value = queue.value.filter(e => e.action !== 'com.lastglance.app.launcher.REFRESH')
      return all
    },
    ackLauncherIntents: (json: string) => {
      const ids = JSON.parse(json) as string[]
      acked.push(...ids)
      queue.value = queue.value.filter(e => !ids.includes(e.clientId as string))
    },
    headlessShouldAbort: () => abort.value,
    headlessDone: (json: string) => { done.push(json) },
  }
  const looked = new Set<string>()
  const bridge = new Proxy(methods, {
    get(target, prop) {
      if (typeof prop === 'string') looked.add(prop)
      return target[prop as string]
    },
  })
  return { bridge, looked, secure, files, requests, snapshots, heartbeats, done, abort, offline, queue, acked }
}

let shell: Shell

async function boot(clientId: string) {
  const g = globalThis as Record<string, unknown>
  g.Storage = FakeStorage
  g.localStorage = new FakeStorage()
  g.sessionStorage = new FakeStorage()
  g.window = globalThis
  // The apply announces itself with DOM events (lg:sync-applied); a WebView has them.
  const events = new EventTarget()
  g.dispatchEvent = events.dispatchEvent.bind(events)
  g.addEventListener = events.addEventListener.bind(events)
  g.removeEventListener = events.removeEventListener.bind(events)
  g.location = { search: `?headless=refresh&clientId=${clientId}` }
  g.LastGlanceHeadless = shell.bridge
  vi.resetModules()
  // Hydrate exactly as main.tsx does before it runs the root.
  const shimMod = await import('@/sync/secureConfigShim')
  shimMod.installSecureConfigShim()
  await shimMod.hydrateSecureConfig()
  const { db } = await import('@/db/client')
  await db.open()
  return { shim: shimMod, db }
}

const remotePayload = () => ({
  categories: [{ id: 'c0ffee00-0000-4000-8000-000000000001', name: 'Garden', sortOrder: 0, icon: undefined, parentId: null, assignedUserSyncIds: [], updatedAt: NOW }],
  chores: [{
    id: 'c0ffee00-0000-4000-8000-000000000002', name: 'Water the tomatoes', categorySyncId: 'c0ffee00-0000-4000-8000-000000000001', sortOrder: 0, targetCadenceDays: 2,
    notifyWhenOverdue: false, autoScheduleToDayglance: false, preferredScheduleBehavior: null,
    seasonalStart: null, seasonalEnd: null, details: null, icon: undefined, assignedUserSyncIds: [],
    createdAt: NOW, updatedAt: NOW,
  }],
  completionEvents: [{ id: 'c0ffee00-0000-4000-8000-000000000003', choreSyncId: 'c0ffee00-0000-4000-8000-000000000002', completedAt: NOW, note: null, source: 'manual', completedByUserSyncId: null }],
  users: [],
  settings: { multiUserEnabled: false },
  tombstones: {},
})

describe('headless refresh, end to end', () => {
  let shim: Awaited<ReturnType<typeof boot>>['shim'] | null = null
  let close: (() => void) | null = null

  beforeEach(() => {
    shell = fakeShell()
    shell.secure.set('lastglance-cloud-sync-config', JSON.stringify({
      enabled: true, provider: 'webdav', webdavUrl: DAV, username: 'me', appPassword: 'secret',
    }))
  })

  afterEach(async () => {
    shim?.uninstallSecureConfigShimForTests()
    close?.()
    shim = null
    close = null
    indexedDB.deleteDatabase('lastglance')
  })

  it("applies another device's chore from WebDAV and pushes it to the launcher", async () => {
    const booted = await boot('rf-1')
    shim = booted.shim
    close = () => booted.db.close()
    const { getSyncFolder } = await import('@/sync/syncFolder')
    const fileUrl = `${DAV}/${getSyncFolder()}/lastglance-sync.json`
    shell.files.set(fileUrl, { body: JSON.stringify({ appId: 'lastglance', lastModified: NOW, data: remotePayload() }), etag: '"e0"' })

    const { headlessBridge, HEADLESS_BRIDGE_METHODS } = await import('./headlessMode')
    const { runHeadlessRefresh } = await import('./headlessRefresh')
    const result = await runHeadlessRefresh('rf-1', { bridge: headlessBridge()! })

    expect(result, JSON.stringify({ result, requests: shell.requests })).toMatchObject({ outcome: 'ran' })
    expect(JSON.parse(shell.done[shell.done.length - 1])).toMatchObject({ clientId: 'rf-1', outcome: 'ran' })
    // The file came over the shell's HTTP, with the credentials from its secure store.
    expect(shell.requests).toContain(`GET ${fileUrl}`)
    // The merge reached IndexedDB...
    expect((await booted.db.chores.toArray()).map(c => c.name)).toContain('Water the tomatoes')
    // ...and the launcher's snapshot, with the completion as its last-done.
    const snapshot = JSON.parse(shell.snapshots[shell.snapshots.length - 1])
    const chore = snapshot.chores.find((c: { id: string }) => c.id === 'c0ffee00-0000-4000-8000-000000000002')
    expect(chore).toMatchObject({ name: 'Water the tomatoes', lastDoneAt: NOW })
    expect(shell.heartbeats.length).toBeGreaterThan(0)
    // Nothing beyond the allowlist was even looked up.
    expect([...shell.looked].filter(m => !(HEADLESS_BRIDGE_METHODS as readonly string[]).includes(m))).toEqual([])
  }, 20_000)

  // A launcher write that reached the app while it was closed: applied after
  // the pull, acknowledged, pushed by a second pass, and in the snapshot.
  // MUTATION: drop the writes step and every expectation below on the new chore fails.
  it("applies the launcher's queued writes after the pull, acknowledges each, pushes them, and puts them in the snapshot", async () => {
    const booted = await boot('rf-4')
    shim = booted.shim
    close = () => booted.db.close()
    const { getSyncFolder } = await import('@/sync/syncFolder')
    const fileUrl = `${DAV}/${getSyncFolder()}/lastglance-sync.json`
    shell.files.set(fileUrl, { body: JSON.stringify({ appId: 'lastglance', lastModified: NOW, data: remotePayload() }), etag: '"e0"' })
    const L = 'com.lastglance.app.launcher.'
    shell.queue.value = [
      { action: `${L}REFRESH`, clientId: 'rf-0', payload: {} },
      { action: `${L}CREATE`, clientId: 'w-new', payload: { title: 'Change the furnace filter' } },
      // The pulled chore: only completable once the pull has landed it.
      { action: `${L}COMPLETE`, clientId: 'w-done', payload: { chore_id: 'c0ffee00-0000-4000-8000-000000000002', completed_at: '2026-10-22T13:00:00.000Z' } },
    ]

    const { headlessBridge, HEADLESS_BRIDGE_METHODS } = await import('./headlessMode')
    const { runHeadlessRefresh } = await import('./headlessRefresh')
    const result = await runHeadlessRefresh('rf-4', { bridge: headlessBridge()! })
    expect(result, JSON.stringify(result)).toMatchObject({ outcome: 'ran' })

    // Landed in IndexedDB…
    expect((await booted.db.chores.toArray()).map(c => c.name)).toContain('Change the furnace filter')
    const events = await booted.db.completionEvents.toArray()
    expect(events.map(e => e.completed_at)).toContain('2026-10-22T13:00:00.000Z')
    // …acknowledged, queue empty…
    expect(shell.acked).toEqual(['w-new', 'w-done'])
    expect(shell.queue.value).toEqual([])
    // …pushed by the second pass: the WebDAV file now carries both…
    const pushed = JSON.parse(shell.files.get(fileUrl)!.body)
    expect(pushed.data.chores.map((c: { name: string }) => c.name)).toContain('Change the furnace filter')
    expect(pushed.data.completionEvents.map((e: { completedAt: string }) => e.completedAt)).toContain('2026-10-22T13:00:00.000Z')
    // …and the snapshot shows the ids the launcher retires its outbox on.
    const snapshot = JSON.parse(shell.snapshots[shell.snapshots.length - 1])
    expect(snapshot.handledWrites.map((h: { clientId: string }) => h.clientId)).toEqual(expect.arrayContaining(['w-new', 'w-done']))
    expect([...shell.looked].filter(m => !(HEADLESS_BRIDGE_METHODS as readonly string[]).includes(m))).toEqual([])
  }, 20_000)

  it('the app opening stops the run before it touches the network', async () => {
    const booted = await boot('rf-2')
    shim = booted.shim
    close = () => booted.db.close()
    shell.abort.value = true
    const { headlessBridge } = await import('./headlessMode')
    const { runHeadlessRefresh } = await import('./headlessRefresh')
    const result = await runHeadlessRefresh('rf-2', { bridge: headlessBridge()! })
    expect(result).toMatchObject({ outcome: 'aborted', reason: 'app opened' })
    expect(shell.requests).toEqual([])
    expect(shell.snapshots).toEqual([])
  })

  it('an unreachable server is a failed run that still re-pushes what the device has', async () => {
    const booted = await boot('rf-3')
    shim = booted.shim
    close = () => booted.db.close()
    shell.offline.value = true
    const { headlessBridge } = await import('./headlessMode')
    const { runHeadlessRefresh } = await import('./headlessRefresh')
    const result = await runHeadlessRefresh('rf-3', { bridge: headlessBridge()! })
    expect(result.outcome).toBe('failed')
    expect(result.reason).toMatch(/^file: /)
    expect(shell.snapshots.length).toBe(1)
    expect(shell.heartbeats.length).toBeGreaterThan(0)
  }, 20_000)
})
