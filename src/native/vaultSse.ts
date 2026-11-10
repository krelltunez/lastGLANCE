import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { desktopBridge } from './desktop'

// Native GLANCEvault SSE reader (Android and iOS shells implement the same
// plugin surface). The WebView cannot stream /events (vault HTTP rides the
// buffered CapacitorHttp path), so the SHELL owns the socket — connecting while
// foreground, dropping on background, reconnecting with backoff — and pushes
// every reader message in as an `sseMessage` plugin event. The renderer's bridge
// client (createBridgeSseClient in src/sync/vaultEventStream.ts) funnels frames
// through the SAME parseSseFrame → coalescer → drains as the web transport.
//
// Message shapes (identical to dayGLANCE's shells, so the renderer logic is
// shared across the app family):
//   {type:'open'}                    a native (re)connection was established
//   {type:'frame', block:'…'}        one raw SSE event block
//   {type:'closed'}                  the stream dropped (native will reconnect)
//   {type:'error', message, code?}   coded errors are TERMINAL — native stopped
//                                    and will NOT reconnect ('auth' = rejected
//                                    token, 'insecure' = refused cleartext URL,
//                                    'unsupported' = server predates /events)

export interface VaultSseNativeMessage {
  type: 'open' | 'frame' | 'closed' | 'error'
  block?: string
  message?: string
  code?: string
}

export interface VaultSsePluginType {
  start(options: { vaultUrl: string; vaultToken: string; accountId: string }): Promise<void>
  stop(): Promise<void>
  addListener(
    eventName: 'sseMessage',
    listenerFunc: (msg: VaultSseNativeMessage) => void,
  ): Promise<PluginListenerHandle>
}

export const VaultSse = registerPlugin<VaultSsePluginType>('VaultSse')

// Strict capability probe: true only when a native shell actually registered
// the plugin. An older shell (APK predating the reader) answers false and the
// app keeps its polling behavior — the same degrade-to-polling contract
// dayGLANCE's shells established.
export function isVaultSseNativeAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('VaultSse')
}

/**
 * The shell's SSE reader, whichever shell this is: the VaultSse plugin on the
 * phones, or the main process on the desktop (electron/vaultSse.ts), which
 * sends the same messages. Null where there is none (web, or a phone shell that
 * predates the plugin), and the app keeps polling.
 */
export interface VaultSseBridge {
  start(options: { vaultUrl: string; vaultToken: string; accountId: string }): Promise<void>
  stop(): Promise<void>
  /** Every reader message; returns the unsubscribe. */
  listen(listener: (msg: VaultSseNativeMessage) => void): () => void
}

export function vaultSseBridge(): VaultSseBridge | null {
  const desktop = desktopBridge()
  if (desktop) {
    return {
      start: options => desktop.vaultSse.start(options),
      stop: () => desktop.vaultSse.stop(),
      listen: listener => desktop.vaultSse.onMessage(msg => listener(msg as VaultSseNativeMessage)),
    }
  }
  if (!isVaultSseNativeAvailable()) return null
  return {
    start: options => VaultSse.start(options),
    stop: () => VaultSse.stop(),
    listen: listener => {
      // Capacitor hands the handle back asynchronously; an unsubscribe that
      // comes first removes it on arrival.
      let handle: PluginListenerHandle | undefined
      let removed = false
      void VaultSse.addListener('sseMessage', listener).then(h => {
        if (removed) void h.remove()
        else handle = h
      })
      return () => {
        removed = true
        void handle?.remove()
      }
    },
  }
}
