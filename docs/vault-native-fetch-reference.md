# GLANCEvault native (Capacitor) fetch reference — for lifeGLANCE

A read-only, implementation-level explainer of how **lastGLANCE** makes its
GLANCEvault DB-sync transport (and its credential-verify / `getSalt` probe and
its intents channel) reach the vault on **native** (Capacitor Android/iOS),
where the WebView would otherwise block cross-origin requests.

Written for lifeGLANCE, whose vault DB engine is wired but whose vault client
falls through to `globalThis.fetch` — which the native WebView blocks — so vault
sync and the credential-verify probe both fail on native with "could not reach
the vault." lastGLANCE does not have this problem.

All `file:line` references are to lastGLANCE at the time of writing. Nothing was
changed to produce this doc.

> **The one thing lifeGLANCE is most likely missing.** lastGLANCE reaches the
> vault on native through **two complementary mechanisms**, not one:
>
> 1. **A global `fetch` patch** from the CapacitorHttp plugin, enabled in
>    `capacitor.config.ts:14-15`. On native this monkeypatches `window.fetch` /
>    XHR to route through the native HTTP stack, **CORS-free**. This is what
>    makes the **DB sync engine** work on native even though lastGLANCE injects
>    *no* fetch into it (see §1).
> 2. **An explicit native-safe `fetch` adapter** injected at the app-owned
>    vault-client sites — the `getSalt` / verify probe (`createVaultClient`) and
>    the intents HTTP path (see §2–§4).
>
> The symptom "vault client falls through to `globalThis.fetch`, which the
> native WebView blocks (CORS)" means that in lifeGLANCE `globalThis.fetch` is
> **not** the CapacitorHttp-patched one. In lastGLANCE it **is**, because
> `CapacitorHttp.enabled: true`. The fix is two-pronged: turn on the global
> patch **and** explicitly inject a native fetch at every site where you
> construct a vault client yourself.

---

## 1. The vault client construction (and what it does NOT pass)

`src/sync/dbEngine.ts:471-492` — the DB sync transport:

```ts
export function createDbEngine(callbacks: DbEngineCallbacks = {}): DbSyncEngine | null {
  if (!isVaultEnabled()) return null
  const cfg = getVaultConfig()!

  const engine = createDbSyncEngine({
    storageKeyPrefix: APP_ID,
    appId: APP_ID,
    vaultApp: APP_ID,
    cryptoDBName: CRYPTO_DB_NAME,
    vaultUrl: cfg.vaultUrl,
    vaultToken: cfg.vaultToken,
    accountId: cfg.accountId,
    deviceId: getDeviceId(),
    getLocalEntity,
    applyRemoteEntity,
    applyRemoteDelete,
    isInsertOnly,
    getEntityLastModified,
    onStatusChange: callbacks.onStatusChange,
    onError: callbacks.onError,
    onRowsSkipped: callbacks.onRowsSkipped,
  })
```

**Crucial:** there is **no `fetchImpl`, no `electronProxyFetch`, and no
`vaultClient`** here. lastGLANCE hands the engine raw
`vaultUrl/vaultToken/accountId`, and the package builds its *own internal* vault
client that calls the **global `fetch`**.

The package *does* accept an injected client — `src/sync/dbEngineMultiDevice.test.ts:90-98`
passes `vaultClient: vault as unknown as VaultClient` — so injection is possible,
but **production deliberately does not use it**. That means the DB sync engine's
native-safety depends entirely on the global `fetch` being native-safe, i.e. on
the CapacitorHttp patch.

`capacitor.config.ts:11-16`:

```ts
plugins: {
  // Route fetch/XHR through the native HTTP stack so WebDAV/Nextcloud sync
  // works without a CORS proxy inside the native WebView.
  CapacitorHttp: {
    enabled: true,
  },
```

That `enabled: true` is the load-bearing line for the sync engine on native.

---

## 2. The native fetch it injects (the (method,url,headers,body) → (url,init)→Response bridge)

For the app-owned vault clients, lastGLANCE injects a real adapter. The base
native primitive is `src/sync/nativeHttp.ts:20-51`, in the
**`(method, url, headers, body)` shape** (the same shape as lifeGLANCE's
`electronProxyFetch` / `nativeRequest`):

```ts
export async function nativeHttpFetch(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | null,
): Promise<NativeHttpResult> {
  const res = await CapacitorHttp.request({
    method, url, headers,
    data: body ?? undefined,
    responseType: 'text',          // force raw string so callers parse themselves
  })
  const ok = res.status >= 200 && res.status < 300
  const data = typeof res.data === 'string' ? res.data : res.data == null ? '' : JSON.stringify(res.data)
  const etag = res.headers?.etag ?? res.headers?.ETag
  return { status: res.status, ok, statusText: '', body: data, headers: etag ? { etag } : undefined }
}
```

The **bridge to the vault client's `(url, init) => Response` contract** is
`vaultFetchImpl()` in `src/intents/setupVaultIntentsEncryption.ts:42-59`. **This
is the precise adaptation** — it converts the `(method,url,headers,body)`
primitive into a standard-`fetch`-shaped function returning a `Response`-like
object exposing `.ok` / `.status` / `.json()` / `.text()`:

```ts
function vaultFetchImpl(): typeof fetch | undefined {
  if (!isNativePlatform) return undefined
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()   // adapt input → url
    const r = await nativeHttpFetch(
      init?.method ?? 'GET',                                            // adapt init.method
      url,
      (init?.headers as Record<string, string>) ?? {},                 // adapt init.headers
      (init?.body as string) ?? null,                                  // adapt init.body
    )
    return {
      ok: r.ok,
      status: r.status,
      json: async () => JSON.parse(r.body),                            // synthesize Response.json()
      text: async () => r.body,                                        // synthesize Response.text()
    } as Response
  }) as typeof fetch
}
```

It satisfies the package contract exactly: the vault client calls
`doFetch(url, init)` and reads `res.status` / `res.ok` / `res.json()`, all of
which this object provides. The header comment (`:40-41`) scopes it: *"only the
subset createVaultClient calls (ok/status/json) is exercised."*

It is injected at the `createVaultClient` site,
`setupVaultIntentsEncryption.ts:69-75` — the **credential-verify / salt path**
(the `getSalt` probe):

```ts
const client = createVaultClient({
  vaultUrl: conn.vaultUrl,
  vaultToken: conn.vaultToken,
  fetchImpl: vaultFetchImpl(),     // native adapter on native; undefined on web
})
const salt = await client.getSalt(conn.accountId)
```

On native this goes through CapacitorHttp via the adapter; on web `vaultFetchImpl()`
returns `undefined` and `createVaultClient` falls back to global `fetch`.

The third vault HTTP site, the **intents transport**, doesn't use
`createVaultClient` — it owns its HTTP and branches inline.
`src/intents/dbTransport.ts:60-88`:

```ts
export async function vaultFetch(conn, method, path, opts = {}): Promise<VaultResponse> {
  const base = conn.vaultUrl.replace(/\/+$/, '')
  let url = base + path
  /* …build query + headers… */
  const headers = { Authorization: `Bearer ${conn.vaultToken}` }
  /* … */
  if (isNativePlatform) {
    const r = await nativeHttpFetch(method, url, headers, body)        // native: CapacitorHttp
    return { status: r.status, ok: r.ok, text: async () => r.body }
  }
  const controller = new AbortController()                            // web: global fetch + timeout
  /* … */
  return fetch(url, { method, headers, ...(body !== null ? { body } : {}), signal: controller.signal })
}
```

Here the app-owned `VaultResponse` contract is just `{ status, ok, text() }`, so
it adapts `nativeHttpFetch` directly without needing the `Response.json()` shim.

---

## 3. The native-vs-web branch

A single source of truth, `src/sync/nativeHttp.ts:6`:

```ts
export const isNativePlatform = Capacitor.isNativePlatform()
```

Every vault-fetch site keys off it and **injects the native path only on
native**, letting web/PWA use the default global `fetch` (the vault server serves
CORS, unlike WebDAV — comments at `dbTransport.ts:57-59` and
`setupVaultIntentsEncryption.ts:38-39`):

- `setupVaultIntentsEncryption.ts:43` → `if (!isNativePlatform) return undefined` (web → global fetch).
- `dbTransport.ts:76` → `if (isNativePlatform) { …nativeHttpFetch… } else { …fetch… }`.
- File-tier WebDAV engine, `engine.ts:500` → `electronProxyFetch: isNativePlatform ? nativeHttpFetch : undefined`.

---

## 4. All the vault HTTP sites (wire ALL of them)

| # | Site | File:line | Builds a vault client? | How it gets native fetch |
|---|------|-----------|------------------------|--------------------------|
| 1 | **DB row sync engine** | `dbEngine.ts:475` `createDbSyncEngine({...})` | Internal (package) | **No explicit fetch** — relies on the global CapacitorHttp patch (`capacitor.config.ts:14`) |
| 2 | **Credential verify / getSalt / root-key salt** | `setupVaultIntentsEncryption.ts:69` `createVaultClient({...})` | Yes (explicit) | Injects `vaultFetchImpl()` (the `(url,init)→Response` adapter) |
| 3 | **Intents send/receive HTTP** | `dbTransport.ts:60` app-owned `vaultFetch` | No — owns HTTP | Inline `isNativePlatform` branch → `nativeHttpFetch` |
| — | (File-tier WebDAV, not vault, same primitive) | `engine.ts:500` | Internal (package) | `electronProxyFetch: nativeHttpFetch` |

There is **no separate blob transport** in lastGLANCE (the only `Blob` usage,
`BackupModal.tsx:50`, is a local file download unrelated to the vault). If
lifeGLANCE has a blob transport that hits the vault, that is a **fourth site**
lastGLANCE doesn't have — wire it the same way.

Takeaway: lastGLANCE secures site #1 via the **global patch** and sites #2/#3 via
**explicit injection**. Mirroring only one site (e.g. the engine) still leaves
the verify probe failing, and vice-versa. Wire **engine init AND the verify probe
AND intents (AND blobs if present)**.

---

## 5. Shared helper or inlined?

It's **a shared primitive (`nativeHttpFetch`) with thin per-contract adapters on
top** — not fully inlined, and not one single universal wrapper either:

- `nativeHttpFetch(method,url,headers,body) → NativeHttpResult` is the one
  reusable CapacitorHttp wrapper (`nativeHttp.ts`), reused by the WebDAV engine,
  the WebDAV intents helper (`intents/webdav.ts:41`), and the vault intents
  transport (`dbTransport.ts:77`).
- On top of it, the `(url,init)=>Response` adapter (`vaultFetchImpl`) exists
  **only where a package `createVaultClient` needs the standard-fetch shape**.

**Recommendation for lifeGLANCE.** Since you already have `nativeRequest` /
`electronProxyFetch` in the `(method,url,headers,body)` shape, add **one** small
shared helper that adapts it to `(url,init)=>Response` — essentially copy
`vaultFetchImpl` verbatim — and pass it as `fetchImpl` at **every**
`createVaultClient` site (your verify probe especially). Keep returning
`undefined` on web so CORS-capable global `fetch` is used there. Then,
separately, enable `CapacitorHttp` in your Capacitor config so the engine's
internal client (which you don't inject into) is also covered. Belt and
suspenders is exactly what lastGLANCE does.

A subtlety worth stating: you *can* avoid relying on the global patch for the
engine by building `createVaultClient({ fetchImpl })` yourself and passing it to
`createDbSyncEngine` as `vaultClient` (the test at
`dbEngineMultiDevice.test.ts:98` shows the engine accepts `vaultClient`).
lastGLANCE chose **not** to and leans on the global patch instead. If you'd
rather not depend on the global monkeypatch, injecting an explicit `vaultClient`
into the engine is the more deterministic route — but confirm your
`@glance-apps/sync` version exposes that option.

---

## 6. General pattern vs. lastGLANCE-specific naming

**General / correct pattern to replicate:**

- A `(url, init) => Response`-shaped adapter over your native HTTP primitive that
  synthesizes `.ok`, `.status`, `.json()`, `.text()` — the contract
  `createVaultClient` / `doFetch` requires.
- A single `isNativePlatform` branch that injects native only on native and
  returns `undefined` (→ global fetch) on web/PWA, because the vault server
  serves CORS while WebDAV doesn't.
- Inject at **every** vault-client construction site, not just the engine.
- Enable the CapacitorHttp global-fetch patch so any client you can't inject into
  (the engine's internal one) is still native-safe.
- Force `responseType: 'text'` (or equivalent) so the body is a raw string the
  caller parses, matching what the codecs / clients expect.

**lastGLANCE-specific naming you'll adapt:**

- Function/file names: `nativeHttpFetch`, `vaultFetchImpl`, `isNativePlatform`,
  `src/sync/nativeHttp.ts`, `setupVaultIntentsEncryption.ts`, `dbTransport.ts`.
- `electronProxyFetch` as the engine config key (the `@glance-apps/sync` option
  name lastGLANCE uses for the WebDAV tier; your vault engine option may differ
  by package version).
- App ids (`com.lastglance.app`, `lastglance`), the `etag` handling in
  `NativeHttpResult` (WebDAV-specific; the vault doesn't need it), and the
  `VaultResponse` / `VaultConn` app-owned shapes in `dbTransport.ts`.
