import { Capacitor, registerPlugin } from '@capacitor/core'

// Native bridge to the Android home-screen widgets. The web app owns the data
// (IndexedDB lives in the WebView), so it pushes a denormalized JSON snapshot
// to native SharedPreferences; the widgets render from that snapshot and never
// touch the database. No-op on web/PWA and iOS (no plugin registered there).
export interface WidgetBridgePlugin {
  // Persist the snapshot JSON and refresh any placed widgets.
  updateSnapshot(options: { json: string }): Promise<void>
}

const WidgetBridge = registerPlugin<WidgetBridgePlugin>('WidgetBridge')

export async function pushWidgetSnapshot(json: string): Promise<void> {
  if (Capacitor.getPlatform() !== 'android') return
  try {
    await WidgetBridge.updateSnapshot({ json })
  } catch {
    // Plugin unavailable or transient failure — widgets are a cosmetic extra,
    // so swallow rather than disrupt the app.
  }
}
