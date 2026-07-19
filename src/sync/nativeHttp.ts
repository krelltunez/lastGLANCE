import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core'

// True when running inside the Capacitor native shell (Android/iOS), false in
// the browser/PWA. Used to bypass the WebDAV CORS proxy: native HTTP requests
// are not subject to the WebView's same-origin policy.
export const isNativePlatform = Capacitor.isNativePlatform()

// Opt-in browser/PWA setting: skip the WebDAV CORS proxy and talk to the target
// server directly. Only meaningful off-native — native already connects
// directly via CapacitorHttp. Enable with VITE_WEBDAV_DIRECT=true when the
// WebDAV server sends permissive CORS headers or sits behind a reverse proxy
// that does. Leaving it unset preserves the default same-origin proxy path.
export const webdavDirect = !isNativePlatform && import.meta.env.VITE_WEBDAV_DIRECT === 'true'

export interface NativeHttpResult {
  status: number
  ok: boolean
  statusText: string
  body: string
  headers?: { etag?: string }
}

// Methods HttpURLConnection accepts. Anything else — the WebDAV extension verbs
// PROPFIND and MKCOL — makes CapacitorHttp's Android backend throw
// ProtocolException ("Invalid HTTP method"), so those route through the
// WebDavHttp OkHttp bridge instead (issue #233). iOS's URLSession accepts
// arbitrary methods, so only Android needs the detour.
const HTTP_URL_CONNECTION_METHODS = new Set(['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'DELETE', 'TRACE', 'PATCH'])

interface WebDavHttpBridge {
  request(options: {
    method: string
    url: string
    headers: Record<string, string>
    body?: string
  }): Promise<{ status: number; body: string; headers: Record<string, string> }>
}

const WebDavHttp = registerPlugin<WebDavHttpBridge>('WebDavHttp')

// Undo server-side ETag mangling so If-Match uploads can strong-match:
// Apache mod_deflate/mod_brotli append "-gzip"/"-br" inside the quoted value on
// re-encoded responses, and some servers downgrade to a weak validator (W/).
// Sending either form back in If-Match makes every PUT fail with 412, which is
// the endless "sync conflict" loop of issue #232.
export function normalizeEtag(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined
  const etag = raw.trim().replace(/^W\//i, '')
  return etag.replace(/-(?:gzip|br)("?)$/, '$1')
}

// Case-insensitive ETag lookup: Android hands back header names exactly as the
// server sent them ("ETag", "Etag", or lowercase "etag" over HTTP/2).
export function etagFromHeaders(headers: Record<string, string> | undefined | null): string | undefined {
  if (!headers) return undefined
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'etag') return normalizeEtag(value)
  }
  return undefined
}

// Direct, CORS-free WebDAV request over the native HTTP stack (CapacitorHttp).
// The signature matches the `ElectronProxyFetch` bridge that @glance-apps/sync
// calls when wired into the engine config, so the same function serves both the
// sync engine and the app's own WebDAV helpers (src/intents/webdav.ts).
export async function nativeHttpFetch(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
): Promise<NativeHttpResult> {
  const verb = method.toUpperCase()
  const requestHeaders = { ...headers }
  // GETs are where the engine captures ETags; ask for an unencoded response so
  // Apache mod_deflate never rewrites the ETag to "...-gzip" in the first place
  // (Android's HttpURLConnection otherwise adds Accept-Encoding: gzip silently).
  // normalizeEtag() below is the safety net for servers that ignore this.
  if (verb === 'GET' && !Object.keys(requestHeaders).some(h => h.toLowerCase() === 'accept-encoding')) {
    requestHeaders['Accept-Encoding'] = 'identity'
  }

  if (!HTTP_URL_CONNECTION_METHODS.has(verb) && Capacitor.getPlatform() === 'android') {
    const res = await WebDavHttp.request({
      method,
      url,
      headers: requestHeaders,
      ...(body !== null ? { body } : {}),
    })
    const etag = etagFromHeaders(res.headers)
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      statusText: '',
      body: res.body,
      headers: etag ? { etag } : undefined,
    }
  }

  const res = await CapacitorHttp.request({
    method,
    url,
    headers: requestHeaders,
    // CapacitorHttp only accepts a string or JSON body on native.
    data: body ?? undefined,
    // Force a raw string body so callers can parse JSON/XML themselves; without
    // this CapacitorHttp may auto-parse JSON and hand back an object.
    responseType: 'text',
  })
  const ok = res.status >= 200 && res.status < 300
  const data =
    typeof res.data === 'string'
      ? res.data
      : res.data == null
        ? ''
        : JSON.stringify(res.data)
  const etag = etagFromHeaders(res.headers)
  return {
    status: res.status,
    ok,
    statusText: '',
    body: data,
    headers: etag ? { etag } : undefined,
  }
}

// Direct browser WebDAV request that bypasses the CORS proxy. Shares the
// `ElectronProxyFetch` signature with nativeHttpFetch so the sync engine and the
// app's WebDAV helpers can swap it in when VITE_WEBDAV_DIRECT is enabled. Unlike
// the proxy path it sends a standard Authorization header, so the target server
// must allow the browser request via CORS (a permissive server or a
// CORS-handling reverse proxy). To expose the ETag cross-origin the server must
// list it in Access-Control-Expose-Headers.
export async function browserDirectFetch(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
): Promise<NativeHttpResult> {
  const res = await fetch(url, {
    method,
    headers,
    ...(body !== null ? { body } : {}),
  })
  const text = await res.text()
  const etag = normalizeEtag(res.headers.get('etag'))
  return {
    status: res.status,
    ok: res.ok,
    statusText: res.statusText,
    body: text,
    headers: etag ? { etag } : undefined,
  }
}
