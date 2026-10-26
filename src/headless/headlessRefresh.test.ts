import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { headlessRequest, HEADLESS_BRIDGE_METHODS, type HeadlessBridge } from './headlessMode'
import { headlessFetch, headlessHttpRequest } from './headlessHttp'
import { runHeadlessRefresh, type HeadlessRoads, type ReportError } from './headlessRefresh'

// The run's protocol in isolation: phase boundaries, how road errors become the
// outcome, and the two HTTP shapes over the shell. The end-to-end walk over the
// real engines is headlessRefresh.scenarios.test.ts.

function fakeBridge(over: Partial<HeadlessBridge> = {}) {
  const done: string[] = []
  const bridge: HeadlessBridge = {
    secureGet: () => JSON.stringify({ value: null }),
    secureSet: () => true,
    secureDelete: () => {},
    httpRequestAsync: () => {},
    updateLauncherSnapshot: () => {},
    touchLauncherHeartbeat: () => {},
    takeLauncherIntents: () => '[]',
    ackLauncherIntents: () => {},
    headlessShouldAbort: () => false,
    headlessDone: (json) => { done.push(json) },
    ...over,
  }
  return { bridge, done }
}

const roads = (...list: { name: string; run: (report: ReportError) => Promise<unknown> }[]) =>
  async (report: ReportError): Promise<HeadlessRoads> => ({
    roads: list.map(r => ({ name: r.name, run: () => r.run(report) })),
    syncedAt: () => null,
  })

describe('headlessRequest', () => {
  it('reads the client id from the query, and is null for the app', () => {
    expect(headlessRequest('?headless=refresh&clientId=rf-9')).toEqual({ clientId: 'rf-9' })
    expect(headlessRequest('?headless=refresh')).toEqual({ clientId: '' })
    expect(headlessRequest('')).toBeNull()
    expect(headlessRequest('?headless=tray')).toBeNull()
  })

  it('the allowlist is what HeadlessBridge.kt implements', () => {
    expect([...HEADLESS_BRIDGE_METHODS].sort()).toEqual([
      'ackLauncherIntents', 'headlessDone', 'headlessShouldAbort', 'httpRequestAsync', 'secureDelete', 'secureGet', 'secureSet',
      'takeLauncherIntents', 'touchLauncherHeartbeat', 'updateLauncherSnapshot',
    ])
  })
})

describe('runHeadlessRefresh', () => {
  it('ran: every road, then the snapshot, then the report', async () => {
    const order: string[] = []
    const { bridge, done } = fakeBridge()
    let t = 1000
    const result = await runHeadlessRefresh('rf-1', {
      bridge,
      now: () => (t += 50),
      buildRoads: roads(
        { name: 'file', run: async () => { order.push('file') } },
        { name: 'vault', run: async () => { order.push('vault') } },
      ),
      pushSnapshot: async () => { order.push('snapshot') },
      applyWrites: async () => { order.push('writes'); return 0 },
    })
    // No write changed anything: the roads run once.
    expect(order).toEqual(['file', 'vault', 'writes', 'snapshot'])
    expect(result).toEqual({ clientId: 'rf-1', outcome: 'ran', durationMs: 50 })
    expect(JSON.parse(done[0])).toEqual(result)
  })

  // MUTATION: skip the second pass and the order loses its second file and vault.
  it('launcher writes are applied after the roads, which run again to push them before the snapshot', async () => {
    const order: string[] = []
    const { bridge } = fakeBridge()
    const result = await runHeadlessRefresh('rf-w', {
      bridge,
      buildRoads: roads(
        { name: 'file', run: async () => { order.push('file') } },
        { name: 'vault', run: async () => { order.push('vault') } },
      ),
      pushSnapshot: async () => { order.push('snapshot') },
      applyWrites: async () => { order.push('writes'); return 2 },
    })
    expect(order).toEqual(['file', 'vault', 'writes', 'file', 'vault', 'snapshot'])
    expect(result.outcome).toBe('ran')
  })

  it('a failure applying the writes is no writes: the run goes on to the snapshot', async () => {
    const pushSnapshot = vi.fn(async () => {})
    const run = vi.fn(async () => {})
    const { bridge } = fakeBridge()
    const result = await runHeadlessRefresh('rf-x', {
      bridge, pushSnapshot,
      buildRoads: roads({ name: 'file', run }),
      applyWrites: async () => { throw new Error('queue unreadable') },
    })
    expect(run).toHaveBeenCalledOnce()
    expect(pushSnapshot).toHaveBeenCalledOnce()
    expect(result.outcome).toBe('ran')
  })

  it('a road that reports an error and does not clear it fails the run, named', async () => {
    const pushSnapshot = vi.fn(async () => {})
    const { bridge } = fakeBridge()
    const result = await runHeadlessRefresh('rf-2', {
      bridge,
      pushSnapshot,
      buildRoads: roads(
        { name: 'file', run: async (report) => { report('file', null); report('file', 'Upload failed: 507') } },
        { name: 'vault', run: async (report) => { report('vault', 'offline'); report('vault', null) } },
        { name: 'people file', run: async () => { throw new Error('boom') } },
      ),
    })
    expect(result.outcome).toBe('failed')
    expect(result.reason).toBe('file: Upload failed: 507; people file: boom')
    // The snapshot is pushed anyway: what applied stays, and checkedAt moves.
    expect(pushSnapshot).toHaveBeenCalledOnce()
  })

  it('aborted at the start builds nothing', async () => {
    const buildRoads = vi.fn(roads())
    const { bridge, done } = fakeBridge({ headlessShouldAbort: () => true })
    const result = await runHeadlessRefresh('rf-3', { bridge, buildRoads, pushSnapshot: vi.fn() })
    expect(result).toMatchObject({ outcome: 'aborted', reason: 'app opened' })
    expect(buildRoads).not.toHaveBeenCalled()
    expect(JSON.parse(done[0]).outcome).toBe('aborted')
  })

  it('aborted after the roads pushes no snapshot', async () => {
    let opened = false
    const pushSnapshot = vi.fn(async () => {})
    const { bridge } = fakeBridge({ headlessShouldAbort: () => opened })
    const result = await runHeadlessRefresh('rf-4', {
      bridge,
      pushSnapshot,
      buildRoads: roads({ name: 'file', run: async () => { opened = true } }),
    })
    expect(result.outcome).toBe('aborted')
    expect(pushSnapshot).not.toHaveBeenCalled()
  })

  it('a failure to build the roads is a failed run, and a broken report never throws', async () => {
    const { bridge } = fakeBridge({ headlessDone: () => { throw new Error('torn down') } })
    const result = await runHeadlessRefresh('rf-5', {
      bridge,
      pushSnapshot: vi.fn(),
      buildRoads: async () => { throw new Error('no IndexedDB') },
    })
    expect(result).toMatchObject({ outcome: 'failed', reason: 'no IndexedDB' })
  })
})

describe('HTTP over the shell', () => {
  const g = globalThis as Record<string, unknown>
  beforeEach(() => { g.window = globalThis })
  afterEach(() => { delete g.__lgHeadlessHttpDone })

  const answering = (result: unknown, seen: unknown[] = []) => fakeBridge({
    httpRequestAsync: (id, method, url, headersJson, body) => {
      seen.push({ method, url, headers: JSON.parse(headersJson), body })
      setTimeout(() => (g.__lgHeadlessHttpDone as (m: unknown) => void)({ id, result }), 0)
    },
  }).bridge

  it('answers the request it was asked, and an error result rejects', async () => {
    const seen: unknown[] = []
    const ok = await headlessHttpRequest(answering({ status: 207, body: '<multistatus/>', headers: { etag: '"x"' } }, seen), 'PROPFIND', 'https://dav/x/', { Depth: '1' }, null)
    expect(ok).toEqual({ status: 207, body: '<multistatus/>', headers: { etag: '"x"' } })
    expect(seen).toEqual([{ method: 'PROPFIND', url: 'https://dav/x/', headers: { Depth: '1' }, body: null }])
    await expect(headlessHttpRequest(answering({ error: 'Unable to resolve host' }), 'GET', 'https://dav/x', {}, null))
      .rejects.toThrow('Unable to resolve host')
  })

  it('the vault fetch builds a Response, with no body where none is allowed', async () => {
    const seen: { headers: Record<string, string>; body: unknown }[] = []
    const fetchJson = headlessFetch(answering({ status: 200, body: '{"rows":[]}', headers: { 'content-type': 'application/json' } }, seen))
    const res = await fetchJson('https://vault/sync/lastglance/list', { method: 'POST', headers: { Authorization: 'Bearer t' }, body: '{}' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ rows: [] })
    expect(seen[0]).toMatchObject({ headers: { authorization: 'Bearer t' }, body: '{}' })

    const empty = await headlessFetch(answering({ status: 204, body: '', headers: {} }))('https://vault/x', { method: 'DELETE' })
    expect(empty.status).toBe(204)
    await expect(headlessFetch(answering({ status: 200, body: '', headers: {} }))('https://vault/x', { method: 'POST', body: new Uint8Array(1) }))
      .rejects.toThrow('only string bodies')
  })
})
