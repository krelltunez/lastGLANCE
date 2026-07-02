import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'

// Native bridge to the Android/Tasker intents transport. The native side stores
// an inbound intent (from a manifest broadcast receiver or an Activity launch)
// in a single SharedPreferences slot; the web app drains it here, runs the pure
// handleIntent(), and reports the result back out as an app.lastglance.RESULT
// broadcast. No-op on web/PWA and iOS (no plugin registered there).
//
// This is the Capacitor equivalent of dayGLANCE's addJavascriptInterface bridge
// (see docs/tasker-intents-architecture.md §8.1): getPendingIntent is now async,
// and the native "wake the WebView" poke becomes a plugin `pendingIntent` event.
export interface IntentsBridgePlugin {
  // Read + clear the single pending-intent slot. `value` is '' when empty, else
  // a JSON string `{ action, payload }`.
  getPendingIntent(): Promise<{ value: string }>
  // Emit the RESULT broadcast: the outcome of a handled action, under the
  // ORIGINAL fully-qualified action so the sender's %action matches.
  reportIntentResult(options: { action: string; result: string }): Promise<void>
  // Emit the NOTIFY broadcast (a chore changed state), plaintext, for a local
  // listener like Tasker to react to.
  sendNotifyBroadcast(options: { payload: string }): Promise<void>
  // Fired by native when a new intent lands while the app is running, so the web
  // app drains immediately rather than waiting for the next visibility/focus.
  addListener(eventName: 'pendingIntent', listenerFunc: () => void): Promise<PluginListenerHandle>
}

const IntentsBridge = registerPlugin<IntentsBridgePlugin>('IntentsBridge')

export function isAndroid(): boolean {
  return Capacitor.getPlatform() === 'android'
}

export interface PendingIntent {
  action: string
  payload: Record<string, unknown>
}

// Reads and clears the native pending-intent slot. Returns null when empty or on
// any error, so callers never have to touch the plugin directly.
export async function nativeGetPendingIntent(): Promise<PendingIntent | null> {
  if (!isAndroid()) return null
  try {
    const res = await IntentsBridge.getPendingIntent()
    const raw = res?.value
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const obj = parsed as Record<string, unknown>
    if (typeof obj.action !== 'string') return null
    const payload = (obj.payload && typeof obj.payload === 'object' ? obj.payload : {}) as Record<string, unknown>
    return { action: obj.action, payload }
  } catch {
    return null
  }
}

export async function nativeReportIntentResult(action: string, resultJson: string): Promise<void> {
  if (!isAndroid()) return
  try {
    await IntentsBridge.reportIntentResult({ action, result: resultJson })
  } catch {
    // A missing plugin / transient bridge error is non-fatal: the handler has
    // already applied its state change; only the outbound ack is lost.
  }
}

export async function nativeSendNotifyBroadcast(payloadJson: string): Promise<void> {
  if (!isAndroid()) return
  try {
    await IntentsBridge.sendNotifyBroadcast({ payload: payloadJson })
  } catch {
    // Best-effort; a dropped NOTIFY just means a local listener misses one event.
  }
}

// Subscribes to the native "an intent just landed" poke. Returns a handle to
// remove the listener, or null off Android / on error.
export async function addPendingIntentListener(cb: () => void): Promise<PluginListenerHandle | null> {
  if (!isAndroid()) return null
  try {
    return await IntentsBridge.addListener('pendingIntent', cb)
  } catch {
    return null
  }
}
