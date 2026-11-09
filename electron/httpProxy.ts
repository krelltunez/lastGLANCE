// The renderer's HTTP, made by the main process (docs/desktop-app.md, section
// 4). The renderer's CSP allows it no network request of its own; WebDAV,
// GLANCEvault, intents and the roster all come through here, so no server
// needs a CORS rule for app://lastglance.
//
// After dayGLANCE's `proxy-fetch` handler (electron/main.ts,
// krelltunez/dayGLANCE@8d72008), with two differences:
//
//  - A request that never got a response (refused address, timeout, network
//    failure, redirect loop) comes back as `{ error }`, not as a made-up HTTP
//    status, and the renderer throws it. That is what Capacitor's native HTTP
//    does on the phones, so the app's error handling sees the same thing on
//    every platform, and no server is blamed for a status it never sent.
//  - Credentials are not carried across origins. A redirect to another
//    scheme, host or port drops Authorization, Cookie and Proxy-Authorization,
//    as browsers do: a WebDAV server that redirects elsewhere must not receive
//    the user's password on the other side.
//
// The transport and the URL check are injected, so this is tested without
// Electron.

export const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'PROPFIND', 'MKCOL']);
export const REQUEST_TIMEOUT_MS = 30_000;
export const MAX_REDIRECTS = 5;

const CREDENTIAL_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

export interface HttpResponse {
  status: number;
  statusText: string;
  body: string;
  /** Response headers, names lowercased. */
  headers: Record<string, string>;
}

export type HttpResult = HttpResponse | { error: string };

export type SendFn = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect: 'manual';
  signal: AbortSignal;
}) => Promise<Response>;

export interface HttpProxyDeps {
  send: SendFn;
  /** Rejects with the reason when the URL may not be fetched. */
  validate: (url: string, isRedirect: boolean) => Promise<void>;
  timeoutMs?: number;
}

function originOf(url: string): string {
  return new URL(url).origin;
}

function withoutCredentials(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())));
}

export function createHttpProxy(deps: HttpProxyDeps) {
  const timeoutMs = deps.timeoutMs ?? REQUEST_TIMEOUT_MS;

  return async function request(
    method: unknown,
    url: unknown,
    headers: unknown,
    body: unknown,
  ): Promise<HttpResult> {
    // Everything arrives over IPC: check the shapes before using them.
    const verb = typeof method === 'string' ? method.toUpperCase() : '';
    if (!ALLOWED_METHODS.has(verb)) return { error: `Method not allowed: ${String(method)}` };
    if (typeof url !== 'string') return { error: 'Invalid URL' };
    if (body != null && typeof body !== 'string') return { error: 'Only text bodies are supported' };
    const requestHeaders: Record<string, string> = {};
    if (headers && typeof headers === 'object') {
      for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
        if (typeof value === 'string') requestHeaders[name] = value;
      }
    }

    try {
      await deps.validate(url, false);
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Invalid URL' };
    }

    // No built-in timeout in net.fetch: a server that stops answering would
    // otherwise hold the sync lock until the app quits.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Followed by hand, because net.fetch's own redirects would skip the URL
      // check: a public server could 302 to http://127.0.0.1/.
      let currentUrl = url;
      let currentMethod = verb;
      let currentBody = typeof body === 'string' ? body : null;
      let currentHeaders = requestHeaders;
      let response: Response;
      for (let hop = 0; ; hop++) {
        response = await deps.send(currentUrl, {
          method: currentMethod,
          headers: currentHeaders,
          redirect: 'manual',
          signal: controller.signal,
          ...(currentBody != null ? { body: currentBody } : {}),
        });
        const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
        if (!location) break;
        if (hop >= MAX_REDIRECTS) return { error: 'Too many redirects' };
        const nextUrl = new URL(location, currentUrl).toString();
        await deps.validate(nextUrl, true);
        if (originOf(nextUrl) !== originOf(currentUrl)) currentHeaders = withoutCredentials(currentHeaders);
        // fetch's method rewrite: 303 always, 301/302 on POST, become a bodyless GET.
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
          currentMethod = 'GET';
          currentBody = null;
        }
        currentUrl = nextUrl;
      }
      const text = await response.text();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => { responseHeaders[name.toLowerCase()] = value; });
      return { status: response.status, statusText: response.statusText, body: text, headers: responseHeaders };
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') {
        return { error: `The server did not respond within ${Math.round(timeoutMs / 1000)} s` };
      }
      return { error: e instanceof Error ? e.message : 'Network error' };
    } finally {
      clearTimeout(timer);
    }
  };
}
