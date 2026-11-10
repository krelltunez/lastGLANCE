import { registerPlugin } from '@capacitor/core'
import { isNativeShell } from './platform'
import { desktopBridge } from './desktop'

// Native bridge to the home-screen widgets. The web app owns the data (IndexedDB
// lives in the WebView), so it pushes a denormalized JSON snapshot to a native
// store; the widgets render from that snapshot and never touch the database.
// No-op on web/PWA, where no plugin is registered.
//
// Both native shells implement the identical interface below — Android over
// SharedPreferences (WidgetBridgePlugin.java), iOS over the group.com.lastglance
// App Group (WidgetBridgePlugin.swift) — so nothing here branches per platform.
export interface WidgetBridgePlugin {
  // Persist the snapshot JSON and refresh any placed widgets.
  updateSnapshot(options: { json: string }): Promise<void>
  // Return and clear the queue of completions logged from widgets (JSON array
  // string). The web app drains this into the DB on foreground.
  drainPendingCompletions(): Promise<{ completions: string }>
  // Return and clear the pending widget body-tap target, or null.
  consumeDeepLink(): Promise<{ deepLink: string | null }>
  // Return and clear text shared into the app to seed a new chore, or null.
  consumeSharedChore(): Promise<{ text: string | null }>
  // The operating system's first day of the week, 0 = Sunday … 6 = Saturday.
  // It reflects the device region and any first-day override the user set,
  // which the WebView's language tag may not carry (issue #362).
  systemWeekStart(): Promise<{ weekStart: number }>
}

const WidgetBridge = registerPlugin<WidgetBridgePlugin>('WidgetBridge')

export async function pushWidgetSnapshot(json: string): Promise<void> {
  // The desktop app's tray is a widget too (docs/desktop-app.md, section 7).
  const desktop = desktopBridge()
  if (desktop) {
    try { desktop.widget.updateSnapshot(json) } catch { /* the tray keeps its last one */ }
    return
  }
  if (!isNativeShell()) return
  try {
    await WidgetBridge.updateSnapshot({ json })
  } catch {
    // Plugin unavailable or transient failure — widgets are a cosmetic extra,
    // so swallow rather than disrupt the app.
  }
}

export interface PendingCompletion {
  choreSyncId: string
  syncId: string
  completedAt: string
}

export async function drainPendingCompletions(): Promise<PendingCompletion[]> {
  if (!isNativeShell()) return []
  try {
    const res = await WidgetBridge.drainPendingCompletions()
    const arr = JSON.parse(res?.completions ?? '[]')
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

export async function consumeDeepLink(): Promise<string | null> {
  // The desktop app stashes lastglance:// links, reminder clicks and tray
  // picks in main, as the phones' shells do (electron/deepLink.ts).
  const desktop = desktopBridge()
  if (desktop) {
    try { return (await desktop.widget.consumeDeepLink())?.deepLink ?? null } catch { return null }
  }
  if (!isNativeShell()) return null
  try {
    const res = await WidgetBridge.consumeDeepLink()
    return res?.deepLink ?? null
  } catch {
    return null
  }
}

export async function consumeSharedChore(): Promise<string | null> {
  if (!isNativeShell()) return null
  try {
    const res = await WidgetBridge.consumeSharedChore()
    return res?.text ?? null
  } catch {
    return null
  }
}

// Null on web, or from a native shell that predates the method.
export async function getSystemWeekStart(): Promise<number | null> {
  if (!isNativeShell()) return null
  try {
    const res = await WidgetBridge.systemWeekStart()
    return typeof res?.weekStart === 'number' ? res.weekStart : null
  } catch {
    return null
  }
}
