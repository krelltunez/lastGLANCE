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

const OK_PROPFIND = new Response('<multistatus/>', { status: 207 })

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => OK_PROPFIND.clone()))
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
