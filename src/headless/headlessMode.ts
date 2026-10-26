// Headless refresh (docs/launcher-integration.md, "Freshness"): the Android
// shell loads the same bundle in a WebView with no Activity, at
// `index.html?headless=refresh&clientId=…`, to run one cycle of every sync road
// and re-push the launcher snapshot while the app's process is dead. main.tsx
// runs src/headless/headlessRefresh.ts instead of App for it.
//
// There is no Capacitor bridge in that WebView: Capacitor needs an Activity.
// The shell injects `window.LastGlanceHeadless` instead (HeadlessBridge.kt),
// and the few modules a run reaches (secureStore, nativeHttp, the vault
// engines' fetch, launcherBridge) ask headlessBridge() first. The query is read
// once per call; it cannot change without a reload.

export const HEADLESS_PARAM = 'headless'
export const HEADLESS_REFRESH = 'refresh'

export interface HeadlessRequest {
  clientId: string
}

// The headless request in a query string, or null when this is the app.
export function headlessRequest(search: string | null | undefined): HeadlessRequest | null {
  const params = new URLSearchParams(search ?? '')
  if (params.get(HEADLESS_PARAM) !== HEADLESS_REFRESH) return null
  return { clientId: params.get('clientId') || '' }
}

export function isHeadlessRefresh(): boolean {
  return typeof window !== 'undefined' && headlessRequest(window.location?.search) !== null
}

// The methods a headless run may call: the allowlist the shell's HeadlessBridge
// implements, and nothing more. A feature that reached for anything else would
// find no method rather than a native side effect. Keep equal to
// HeadlessBridge.kt; headlessRefresh.test.ts holds the run to it.
export const HEADLESS_BRIDGE_METHODS = Object.freeze([
  // The sync keys and credentials (SecureStore's Keystore-backed prefs).
  'secureGet', 'secureSet', 'secureDelete',
  // The sync transports: WebDAV and the vault, over OkHttp.
  'httpRequestAsync',
  // The launcher's read model and freshness.
  'updateLauncherSnapshot', 'touchLauncherHeartbeat',
  // The launcher's write queue: taken, then acknowledged once each write is handled.
  'takeLauncherIntents', 'ackLauncherIntents',
  // The run's own protocol with the worker.
  'headlessShouldAbort', 'headlessDone',
] as const)

export interface HeadlessBridge {
  // `{"value": string | null}`; a JSON envelope so an absent key is unambiguous.
  secureGet(key: string): string
  secureSet(key: string, value: string): boolean
  secureDelete(key: string): void
  // Answers through window.__lgHeadlessHttpDone({ id, result }) (headlessHttp.ts).
  httpRequestAsync(callId: string, method: string, url: string, headersJson: string, body: string | null): void
  updateLauncherSnapshot(json: string): void
  touchLauncherHeartbeat(json: string): void
  takeLauncherIntents(): string
  ackLauncherIntents(idsJson: string): void
  headlessShouldAbort(): boolean
  headlessDone(json: string): void
}

declare global {
  interface Window {
    LastGlanceHeadless?: HeadlessBridge
  }
}

// The shell's bridge inside a headless run, or null in the app (and in a
// browser that opened the query by hand: no bridge, nothing headless).
export function headlessBridge(): HeadlessBridge | null {
  if (!isHeadlessRefresh()) return null
  return window.LastGlanceHeadless ?? null
}

// The outcomes a headless run reports through `headlessDone`.
export const HEADLESS_OUTCOMES = Object.freeze({
  RAN: 'ran',
  FAILED: 'failed',
  // The app opened during the run: the live instance takes over (the reverse lock).
  ABORTED: 'aborted',
} as const)

export type HeadlessOutcome = typeof HEADLESS_OUTCOMES[keyof typeof HEADLESS_OUTCOMES]
