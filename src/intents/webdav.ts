import { isNativePlatform, nativeHttpFetch, webdavDirect } from '@/sync/nativeHttp'

export function buildAuthHeader(username: string, password: string): string {
  return 'Basic ' + btoa(`${username}:${password}`)
}

function withProxy(url: string): string {
  const proxy = import.meta.env.VITE_WEBDAV_PROXY_URL ?? ''
  return `${proxy}/api/webdav-proxy/?url=${encodeURIComponent(url)}`
}

const WEBDAV_TIMEOUT_MS = 15_000

function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'AbortError')), WEBDAV_TIMEOUT_MS)
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

// Minimal Response-like shape shared by both transports (Response satisfies it).
// headers is optional because the native transport returns a plain object; the
// proxy/direct transports return a real Response with a readable Headers.
interface WebdavResponse {
  status: number
  ok: boolean
  statusText: string
  text: () => Promise<string>
  headers?: { get: (name: string) => string | null }
}

// Marker header the WebDAV proxy stamps on every response. It lets a proxied
// request tell a genuine proxy reply apart from a static host that 404s the
// /api/webdav-proxy/ path or serves an SPA index.html fallback. Keep in sync
// with api/webdav-proxy.js and the dev middleware in vite.config.ts.
const WEBDAV_PROXY_MARKER = 'x-webdav-proxy'
const WEBDAV_PROXY_MARKER_VALUE = 'lastglance'

// Transport-selecting WebDAV request. On native (Capacitor) it calls the target
// URL directly through the native HTTP stack with a standard Authorization
// header — no CORS proxy. When VITE_WEBDAV_DIRECT is enabled it does the same
// from the browser with a plain fetch (the server must permit the cross-origin
// request via CORS). Otherwise, in the browser/PWA, it routes through the CORS
// proxy with the X-WebDAV-Auth header (which the proxy rewrites to Authorization).
async function webdavFetch(
  method: string,
  targetUrl: string,
  authHeader: string,
  opts: { extraHeaders?: Record<string, string>; body?: string } = {},
): Promise<WebdavResponse> {
  const { extraHeaders = {}, body } = opts
  if (isNativePlatform) {
    const headers: Record<string, string> = { Authorization: authHeader, ...extraHeaders }
    const r = await nativeHttpFetch(method, targetUrl, headers, body ?? null)
    return { status: r.status, ok: r.ok, statusText: r.statusText, text: async () => r.body }
  }
  if (webdavDirect) {
    return fetchWithTimeout(targetUrl, {
      method,
      headers: { Authorization: authHeader, ...extraHeaders },
      ...(body !== undefined ? { body } : {}),
    })
  }
  return fetchWithTimeout(withProxy(targetUrl), {
    method,
    headers: { 'X-WebDAV-Auth': authHeader, ...extraHeaders },
    ...(body !== undefined ? { body } : {}),
  })
}

function buildFolderUrl(baseUrl: string, folderPath: string): string {
  const base = baseUrl.replace(/\/$/, '')
  const folder = folderPath.replace(/^\//, '').replace(/\/$/, '')
  return `${base}/${folder}`
}

export async function ensureFolder(baseUrl: string, folderPath: string, authHeader: string): Promise<void> {
  const base = baseUrl.replace(/\/$/, '')
  const segments = folderPath.replace(/^\//, '').replace(/\/$/, '').split('/')
  let current = ''
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment
    const url = `${base}/${current}/`
    try {
      await webdavFetch('MKCOL', url, authHeader)
    } catch {
      // ignore errors silently
    }
  }
}

export async function putFile(baseUrl: string, folderPath: string, filename: string, content: string, authHeader: string): Promise<void> {
  const folderUrl = buildFolderUrl(baseUrl, folderPath)
  const url = `${folderUrl}/${filename}`
  const res = await webdavFetch('PUT', url, authHeader, {
    extraHeaders: { 'Content-Type': 'application/json' },
    body: content,
  })
  if (!res.ok) {
    throw new Error(`PUT ${filename} failed: ${res.status} ${res.statusText}`)
  }
}


const HREF_RE = /<[^>]*:href[^>]*>([^<]*)<\/[^>]*:href>/gi

const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><allprop/></propfind>'

export async function listFiles(baseUrl: string, folderPath: string, authHeader: string): Promise<string[]> {
  const folderUrl = buildFolderUrl(baseUrl, folderPath) + '/'
  try {
    const res = await webdavFetch('PROPFIND', folderUrl, authHeader, {
      extraHeaders: { Depth: '1', 'Content-Type': 'application/xml' },
      body: PROPFIND_BODY,
    })
    if (res.status === 404) return []
    if (!res.ok) return []
    const text = await res.text()
    const filenames: string[] = []
    let match: RegExpExecArray | null
    HREF_RE.lastIndex = 0
    while ((match = HREF_RE.exec(text)) !== null) {
      const href = decodeURIComponent(match[1].trim())
      const filename = href.split('/').pop() ?? ''
      if (filename.endsWith('.json')) {
        filenames.push(filename)
      }
    }
    return filenames
  } catch {
    return []
  }
}

export async function getFile(baseUrl: string, folderPath: string, filename: string, authHeader: string): Promise<string> {
  const folderUrl = buildFolderUrl(baseUrl, folderPath)
  const url = `${folderUrl}/${filename}`
  const res = await webdavFetch('GET', url, authHeader)
  if (!res.ok) {
    throw new Error(`GET ${filename} failed: ${res.status} ${res.statusText}`)
  }
  return res.text()
}

export async function getFileOrNull(baseUrl: string, folderPath: string, filename: string, authHeader: string): Promise<string | null> {
  const folderUrl = buildFolderUrl(baseUrl, folderPath)
  const url = `${folderUrl}/${filename}`
  const res = await webdavFetch('GET', url, authHeader)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${filename} failed: ${res.status} ${res.statusText}`)
  return res.text()
}

export async function testConnection(baseUrl: string, folderPath: string, username: string, password: string): Promise<{ success: boolean; error?: string }> {
  const authHeader = buildAuthHeader(username, password)
  const folderUrl = buildFolderUrl(baseUrl, folderPath) + '/'
  const usingProxy = !isNativePlatform && !webdavDirect
  try {
    const res = await webdavFetch('PROPFIND', folderUrl, authHeader, {
      extraHeaders: { Depth: '0', 'Content-Type': 'application/xml' },
      body: PROPFIND_BODY,
    })
    // In proxy mode a reply without the proxy marker never reached the proxy —
    // e.g. a static host 404ing /api/webdav-proxy/, or an SPA index.html
    // fallback returning 200. Either way the WebDAV server was never contacted,
    // so don't report success off a misleading status code.
    if (usingProxy && res.headers?.get(WEBDAV_PROXY_MARKER) !== WEBDAV_PROXY_MARKER_VALUE) {
      return {
        success: false,
        error: 'WebDAV proxy not reachable. The /api/webdav-proxy endpoint did not respond — deploy the proxy sidecar, or set VITE_WEBDAV_DIRECT=true to connect directly.',
      }
    }
    if (res.status === 401) return { success: false, error: 'Authentication failed' }
    if (res.status === 403) return { success: false, error: 'Access denied' }
    if (res.ok || res.status === 207 || res.status === 404) return { success: true }
    return { success: false, error: `Server returned ${res.status} ${res.statusText}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: `Network error: ${message}` }
  }
}
