import { App as CapacitorApp } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'
import { dismissTop } from '@/utils/dismissStack'

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

export function initHardwareBackButton(): void {
  if (Capacitor.getPlatform() !== 'android') return
  void CapacitorApp.addListener('backButton', ({ canGoBack }) => {
    // An open window closes first (see utils/dismissStack), one per press.
    if (dismissTop()) return
    if (canGoBack) window.history.back()
    else leaveApp()
  })
}
