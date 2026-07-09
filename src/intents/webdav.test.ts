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
