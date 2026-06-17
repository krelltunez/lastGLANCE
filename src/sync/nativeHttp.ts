import { Capacitor, CapacitorHttp } from '@capacitor/core'

// True when running inside the Capacitor native shell (Android/iOS), false in
// the browser/PWA. Used to bypass the WebDAV CORS proxy: native HTTP requests
// are not subject to the WebView's same-origin policy.
export const isNativePlatform = Capacitor.isNativePlatform()

export interface NativeHttpResult {
  status: number
  ok: boolean
  statusText: string
  body: string
  headers?: { etag?: string }
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
  const res = await CapacitorHttp.request({
    method,
    url,
    headers,
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
  const etag = res.headers?.etag ?? res.headers?.ETag
  return {
    status: res.status,
    ok,
    statusText: '',
    body: data,
    headers: etag ? { etag } : undefined,
  }
}
