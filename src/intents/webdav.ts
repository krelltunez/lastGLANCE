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
      await fetchWithTimeout(withProxy(url), {
        method: 'MKCOL',
        headers: { 'X-WebDAV-Auth': authHeader },
      })
    } catch {
      // ignore errors silently
    }
  }
}

export async function putFile(baseUrl: string, folderPath: string, filename: string, content: string, authHeader: string): Promise<void> {
  const folderUrl = buildFolderUrl(baseUrl, folderPath)
  const url = `${folderUrl}/${filename}`
  const res = await fetchWithTimeout(withProxy(url), {
    method: 'PUT',
    headers: {
      'X-WebDAV-Auth': authHeader,
      'Content-Type': 'application/json',
    },
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
    const res = await fetchWithTimeout(withProxy(folderUrl), {
      method: 'PROPFIND',
      headers: {
        'X-WebDAV-Auth': authHeader,
        Depth: '1',
        'Content-Type': 'application/xml',
      },
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
  const res = await fetchWithTimeout(withProxy(url), {
    method: 'GET',
    headers: { 'X-WebDAV-Auth': authHeader },
  })
  if (!res.ok) {
    throw new Error(`GET ${filename} failed: ${res.status} ${res.statusText}`)
  }
  return res.text()
}

export async function getFileOrNull(baseUrl: string, folderPath: string, filename: string, authHeader: string): Promise<string | null> {
  const folderUrl = buildFolderUrl(baseUrl, folderPath)
  const url = `${folderUrl}/${filename}`
  const res = await fetchWithTimeout(withProxy(url), {
    method: 'GET',
    headers: { 'X-WebDAV-Auth': authHeader },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${filename} failed: ${res.status} ${res.statusText}`)
  return res.text()
}

export async function testConnection(baseUrl: string, folderPath: string, username: string, password: string): Promise<{ success: boolean; error?: string }> {
  const authHeader = buildAuthHeader(username, password)
  const folderUrl = buildFolderUrl(baseUrl, folderPath) + '/'
  try {
    const res = await fetchWithTimeout(withProxy(folderUrl), {
      method: 'PROPFIND',
      headers: {
        'X-WebDAV-Auth': authHeader,
        Depth: '0',
        'Content-Type': 'application/xml',
      },
      body: PROPFIND_BODY,
    })
    if (res.status === 401) return { success: false, error: 'Authentication failed' }
    if (res.status === 403) return { success: false, error: 'Access denied' }
    if (res.ok || res.status === 207 || res.status === 404) return { success: true }
    return { success: false, error: `Server returned ${res.status} ${res.statusText}` }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { success: false, error: `Network error: ${message}` }
  }
}
