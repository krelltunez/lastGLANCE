import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopHttpResult } from '@/native/desktop'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

function desktopWindow(request: (...args: unknown[]) => Promise<DesktopHttpResult>) {
  vi.stubGlobal('window', {
    lastGlanceDesktop: {
      info: { platform: 'darwin', version: '3.0.1', isMAS: false },
      shell: { setMenuLabels: () => {}, setTheme: () => {}, exitFullscreen: () => {} },
      http: { request, inspect: vi.fn(), grant: vi.fn(), grants: vi.fn(), revoke: vi.fn() },
    },
  })
}

describe('desktopFetch', () => {
  it('sends method, URL, flattened headers and a string body to the main process', async () => {
    const { desktopFetch } = await import('./shellFetch')
    const request = vi.fn(async () => ({ status: 200, statusText: 'OK', body: '{"a":1}', headers: { 'content-type': 'application/json' } }))
    const res = await desktopFetch({ request })('https://vault.example.com/v1/sync', {
      method: 'post',
      headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
      body: '{"rows":[]}',
    })
    expect(request).toHaveBeenCalledWith('POST', 'https://vault.example.com/v1/sync', { authorization: 'Bearer t', 'content-type': 'application/json' }, '{"rows":[]}')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ a: 1 })
    expect(res.headers.get('content-type')).toBe('application/json')
  })

  it('rejects like fetch when no response came back', async () => {
    const { desktopFetch } = await import('./shellFetch')
    const fetchImpl = desktopFetch({ request: async () => ({ error: 'Private/reserved address' }) })
    await expect(fetchImpl('https://192.168.1.2/')).rejects.toThrow(new TypeError('Private/reserved address'))
  })

  it('gives a bodyless status no body, and refuses non-string bodies', async () => {
    const { desktopFetch } = await import('./shellFetch')
    const fetchImpl = desktopFetch({ request: async () => ({ status: 204, statusText: '', body: '', headers: {} }) })
    expect((await fetchImpl('https://vault.example.com/x', { method: 'DELETE' })).status).toBe(204)
    await expect(fetchImpl('https://vault.example.com/x', { method: 'PUT', body: new Uint8Array(2) })).rejects.toThrow(TypeError)
  })
})

describe('shellFetchImpl', () => {
  it('leaves the platform fetch alone on the web and the phones', async () => {
    const { shellFetchImpl } = await import('./shellFetch')
    expect(shellFetchImpl()).toBeUndefined()
  })

  it('routes the vault through the main process on the desktop', async () => {
    const request = vi.fn(async () => ({ status: 200, statusText: '', body: 'ok', headers: {} }))
    desktopWindow(request)
    const { shellFetchImpl } = await import('./shellFetch')
    const fetchImpl = shellFetchImpl()
    expect(fetchImpl).toBeTypeOf('function')
    await fetchImpl!('https://vault.example.com/v1/salt')
    expect(request).toHaveBeenCalledWith('GET', 'https://vault.example.com/v1/salt', {}, null)
  })
})

describe('nativeHttpFetch on the desktop', () => {
  it('counts the desktop as native HTTP, so WebDAV skips the web proxy', async () => {
    desktopWindow(vi.fn())
    const { hasNativeHttp, isNativePlatform, webdavDirect } = await import('./nativeHttp')
    expect([hasNativeHttp, isNativePlatform, webdavDirect]).toEqual([true, false, false])
  })

  it('goes through the main process, normalizing the ETag', async () => {
    const request = vi.fn(async () => ({ status: 207, statusText: 'Multi-Status', body: '<d/>', headers: { etag: 'W/"abc-gzip"' } }))
    desktopWindow(request)
    const { nativeHttpFetch } = await import('./nativeHttp')
    expect(await nativeHttpFetch('PROPFIND', 'https://dav.example.com/', { Depth: '1' }, null)).toEqual({
      status: 207, ok: true, statusText: 'Multi-Status', body: '<d/>', headers: { etag: '"abc"' },
    })
    // GETs ask for an unencoded body, as on the phones.
    await nativeHttpFetch('GET', 'https://dav.example.com/f.json', {}, null)
    expect(request).toHaveBeenLastCalledWith('GET', 'https://dav.example.com/f.json', { 'Accept-Encoding': 'identity' }, null)
  })

  it('throws when no response came back, as CapacitorHttp does', async () => {
    desktopWindow(async () => ({ error: 'The server did not respond within 30 s' }))
    const { nativeHttpFetch } = await import('./nativeHttp')
    await expect(nativeHttpFetch('GET', 'https://dav.example.com/', {}, null)).rejects.toThrow('The server did not respond within 30 s')
  })
})
