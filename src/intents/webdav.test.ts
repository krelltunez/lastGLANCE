import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// webdavFetch picks its transport from two module-level consts in
// @/sync/nativeHttp (isNativePlatform, webdavDirect). Those are evaluated at
// import time, so each test resets the module registry and re-imports webdav.ts
// under a fresh mock to exercise a specific transport.
async function loadWebdav(mock: { isNativePlatform: boolean; webdavDirect: boolean }) {
  vi.resetModules()
  vi.doMock('@/sync/nativeHttp', () => ({
    isNativePlatform: mock.isNativePlatform,
    webdavDirect: mock.webdavDirect,
    nativeHttpFetch: vi.fn(),
    browserDirectFetch: vi.fn(),
  }))
  return import('./webdav')
}

// Responses from the real proxy carry this marker; a static host 404 / SPA
// fallback does not.
const PROXY_MARKER = { 'X-Webdav-Proxy': 'lastglance' }

function stubFetch(status: number, headers: Record<string, string> = {}) {
  const fn = vi.fn(async () => new Response('<multistatus/>', { status, headers }))
  vi.stubGlobal('fetch', fn)
  return fn
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('<multistatus/>', { status: 207, headers: PROXY_MARKER })))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.doUnmock('@/sync/nativeHttp')
})

describe('webdavFetch transport selection (browser)', () => {
  it('default (proxy) mode: routes through the same-origin proxy with X-WebDAV-Auth', async () => {
    const { testConnection } = await loadWebdav({ isNativePlatform: false, webdavDirect: false })
    await testConnection('https://dav.example.com', 'chores', 'user', 'pass')

    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('/api/webdav-proxy/?url=' + encodeURIComponent('https://dav.example.com/chores/'))
    expect(init.headers['X-WebDAV-Auth']).toBe('Basic ' + btoa('user:pass'))
    // The proxy path must NOT leak a standard Authorization header.
    expect(init.headers.Authorization).toBeUndefined()
  })

  it('direct mode: hits the target URL directly with a standard Authorization header', async () => {
    const { testConnection } = await loadWebdav({ isNativePlatform: false, webdavDirect: true })
    await testConnection('https://dav.example.com', 'chores', 'user', 'pass')

    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://dav.example.com/chores/')
    expect(url).not.toContain('/api/webdav-proxy/')
    expect(init.headers.Authorization).toBe('Basic ' + btoa('user:pass'))
    expect(init.headers['X-WebDAV-Auth']).toBeUndefined()
  })
})

describe('testConnection proxy reachability (issue #196)', () => {
  it('proxy 404 WITHOUT the marker (missing sidecar / static host) -> failure, not success', async () => {
    stubFetch(404) // no marker header — this is a plain static-host 404
    const { testConnection } = await loadWebdav({ isNativePlatform: false, webdavDirect: false })
    const r = await testConnection('https://dav.example.com', 'chores', 'user', 'pass')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/proxy not reachable/i)
  })

  it('SPA fallback 200 WITHOUT the marker (static host serves index.html) -> failure', async () => {
    stubFetch(200) // no marker — index.html fallback masquerading as success
    const { testConnection } = await loadWebdav({ isNativePlatform: false, webdavDirect: false })
    const r = await testConnection('https://dav.example.com', 'chores', 'user', 'pass')
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/proxy not reachable/i)
  })

  it('proxy 404 WITH the marker (server reachable, folder not created yet) -> success', async () => {
    stubFetch(404, PROXY_MARKER)
    const { testConnection } = await loadWebdav({ isNativePlatform: false, webdavDirect: false })
    const r = await testConnection('https://dav.example.com', 'chores', 'user', 'pass')
    expect(r).toEqual({ success: true })
  })

  it('proxy 207 WITH the marker -> success', async () => {
    stubFetch(207, PROXY_MARKER)
    const { testConnection } = await loadWebdav({ isNativePlatform: false, webdavDirect: false })
    const r = await testConnection('https://dav.example.com', 'chores', 'user', 'pass')
    expect(r).toEqual({ success: true })
  })

  it('proxy 401 WITH the marker -> auth failure (marker check does not mask real statuses)', async () => {
    stubFetch(401, PROXY_MARKER)
    const { testConnection } = await loadWebdav({ isNativePlatform: false, webdavDirect: false })
    const r = await testConnection('https://dav.example.com', 'chores', 'user', 'pass')
    expect(r).toEqual({ success: false, error: 'Authentication failed' })
  })

  it('direct mode 404 -> success without needing any marker', async () => {
    stubFetch(404) // direct transport, no proxy marker expected
    const { testConnection } = await loadWebdav({ isNativePlatform: false, webdavDirect: true })
    const r = await testConnection('https://dav.example.com', 'chores', 'user', 'pass')
    expect(r).toEqual({ success: true })
  })
})

describe('ensureFolder (issue #201: no MKCOL when the folder already exists)', () => {
  // Routes stubbed fetch responses by HTTP method and records every call so tests
  // can assert exactly which verbs hit the wire.
  function routeByMethod(handlers: Record<string, () => Response>) {
    const calls: { method: string; url: string }[] = []
    const fn = vi.fn(async (url: string, init: RequestInit) => {
      const method = String(init.method)
      calls.push({ method, url: String(url) })
      const handler = handlers[method]
      return handler ? handler() : new Response('', { status: 500 })
    })
    vi.stubGlobal('fetch', fn)
    return calls
  }

  // ensureFolder persists its "folder exists" cache in localStorage; the node test
  // env has none, so install a Map-backed stub.
  function fakeLocalStorage() {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size
      },
    })
    return store
  }

  it('probes with PROPFIND and skips MKCOL entirely when the folder exists', async () => {
    fakeLocalStorage()
    const calls = routeByMethod({
      PROPFIND: () => new Response('<multistatus/>', { status: 207 }),
      MKCOL: () => new Response('', { status: 201 }),
    })
    const { ensureFolder } = await loadWebdav({ isNativePlatform: false, webdavDirect: true })
    await ensureFolder('https://dav.example.com', 'GLANCE/lastglance', 'auth')
    const methods = calls.map(c => c.method)
    expect(methods).toContain('PROPFIND')
    expect(methods).not.toContain('MKCOL')
  })

  it('creates each path segment in order when the folder is missing (PROPFIND 404)', async () => {
    fakeLocalStorage()
    const calls = routeByMethod({
      PROPFIND: () => new Response('', { status: 404 }),
      MKCOL: () => new Response('', { status: 201 }),
    })
    const { ensureFolder } = await loadWebdav({ isNativePlatform: false, webdavDirect: true })
    await ensureFolder('https://dav.example.com', 'GLANCE/lastglance', 'auth')
    const mkcols = calls.filter(c => c.method === 'MKCOL').map(c => c.url)
    expect(mkcols).toEqual([
      'https://dav.example.com/GLANCE/',
      'https://dav.example.com/GLANCE/lastglance/',
    ])
  })

  it('caches success so a reload / second call issues no further requests', async () => {
    fakeLocalStorage()
    const calls = routeByMethod({
      PROPFIND: () => new Response('<multistatus/>', { status: 207 }),
      MKCOL: () => new Response('', { status: 201 }),
    })
    const { ensureFolder } = await loadWebdav({ isNativePlatform: false, webdavDirect: true })
    await ensureFolder('https://dav.example.com', 'GLANCE/lastglance', 'auth')
    const afterFirst = calls.length
    await ensureFolder('https://dav.example.com', 'GLANCE/lastglance', 'auth')
    expect(calls.length).toBe(afterFirst)
  })

  it('surfaces a genuine MKCOL failure to the console without throwing', async () => {
    fakeLocalStorage()
    routeByMethod({
      PROPFIND: () => new Response('', { status: 404 }),
      MKCOL: () => new Response('', { status: 403 }),
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ensureFolder } = await loadWebdav({ isNativePlatform: false, webdavDirect: true })
    await expect(ensureFolder('https://dav.example.com', 'GLANCE', 'auth')).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('stays silent when MKCOL returns 405 (collection already exists)', async () => {
    fakeLocalStorage()
    routeByMethod({
      PROPFIND: () => new Response('', { status: 404 }),
      MKCOL: () => new Response('', { status: 405 }),
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ensureFolder } = await loadWebdav({ isNativePlatform: false, webdavDirect: true })
    await ensureFolder('https://dav.example.com', 'GLANCE', 'auth')
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('forgetEnsuredFolders clears the cache so the next call re-probes', async () => {
    fakeLocalStorage()
    const calls = routeByMethod({
      PROPFIND: () => new Response('<multistatus/>', { status: 207 }),
      MKCOL: () => new Response('', { status: 201 }),
    })
    const { ensureFolder, forgetEnsuredFolders } = await loadWebdav({ isNativePlatform: false, webdavDirect: true })
    await ensureFolder('https://dav.example.com', 'GLANCE/lastglance', 'auth')
    const afterFirst = calls.length
    forgetEnsuredFolders()
    await ensureFolder('https://dav.example.com', 'GLANCE/lastglance', 'auth')
    expect(calls.length).toBeGreaterThan(afterFirst)
  })
})
