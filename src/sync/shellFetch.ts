import { headlessFetchImpl } from '@/headless/headlessHttp'
import { desktopBridge, type DesktopHttp } from '@/native/desktop'

// The fetch the GLANCEvault engines give createVaultClient (`fetchImpl`):
//  - in Android's headless refresh, the shell's OkHttp (headlessFetchImpl);
//  - in the Electron desktop app, the main process (docs/desktop-app.md,
//    section 4), because the renderer's CSP allows it no request of its own;
//  - elsewhere undefined, which leaves the vault client on the platform fetch
//    (patched by CapacitorHttp in the phone apps, plain fetch on the web).
export function shellFetchImpl(): typeof fetch | undefined {
  const headless = headlessFetchImpl()
  if (headless) return headless
  const desktop = desktopBridge()
  return desktop ? desktopFetch(desktop.http) : undefined
}

// Statuses whose Response may not carry a body.
const NULL_BODY = new Set([204, 205, 304])

// A fetch over the main process. String bodies only, as the vault speaks JSON;
// a request that got no response rejects with a TypeError, as fetch does.
export function desktopFetch(http: Pick<DesktopHttp, 'request'>): typeof fetch {
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers: Record<string, string> = {}
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value })
    const body = init?.body
    if (body != null && typeof body !== 'string') throw new TypeError('desktop fetch: only string bodies')
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError')
    const res = await http.request(method, url, headers, body ?? null)
    if ('error' in res) throw new TypeError(res.error)
    return new Response(NULL_BODY.has(res.status) ? null : res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }
}
