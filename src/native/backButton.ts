import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'

// Restores the hardware back button that adding @capacitor/app silently broke.
// The plugin registers an always-enabled OnBackPressedDispatcher callback on
// load, and its no-JS-listener branch does NOTHING when the WebView has no
// history (AppPlugin.handleOnBackPressed) — so merely installing the plugin
// swallowed every back press in this no-router SPA. With a listener registered,
// the plugin hands the press to us instead; this one app-wide handler
// reimplements what the system default did before the plugin existed:
// WebView history → go back; otherwise → move the task to the background.

// Leave the app the way the pre-@capacitor/app system default did:
// moveTaskToBack, i.e. background the task (warm resume), not finish() it.
// Shared by the hardware back button (below) and the paywall gate's X, so the
// two can never diverge (Play Subscriptions-policy dismiss control).
export function leaveApp(): void {
  CapacitorApp.minimizeApp().catch(() => {})
}

// Full-screen surfaces that Back should dismiss before it leaves the app (the
// settings sheet). Last registered wins, so a surface opened on top of another
// closes first.
const backHandlers: Array<() => void> = []

/** Make Back close a surface while it is open. Returns the unregister function. */
export function pushBackHandler(handler: () => void): () => void {
  backHandlers.push(handler)
  return () => {
    const i = backHandlers.lastIndexOf(handler)
    if (i !== -1) backHandlers.splice(i, 1)
  }
}

export function initHardwareBackButton(): void {
  if (Capacitor.getPlatform() !== 'android') return
  void CapacitorApp.addListener('backButton', ({ canGoBack }) => {
    const top = backHandlers[backHandlers.length - 1]
    if (top) top()
    else if (canGoBack) window.history.back()
    else leaveApp()
  })
}
