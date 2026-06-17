import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'

// Sync the native status bar with the app's light/dark theme. No-op in the
// browser/PWA, and any plugin error is swallowed (non-fatal cosmetic concern).
//
// On Android, targetSdk 36 forces edge-to-edge (Android 15+), where
// setBackgroundColor is ignored. So instead of coloring the bar we make it
// transparent and overlay the WebView, letting the app's own background paint
// behind it — paired with viewport-fit=cover + env(safe-area-inset-top) padding
// in the layout so content isn't drawn under the bar.
export async function applyStatusBarTheme(isDark: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  try {
    // Style.Dark = light icons (for a dark bar); Style.Light = dark icons.
    await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light })
    if (Capacitor.getPlatform() === 'android') {
      await StatusBar.setOverlaysWebView({ overlay: true })
    }
  } catch {
    // Plugin unavailable or transient failure — leave the OS default.
  }
}

// Hide the status bar in landscape for a full-screen view; show it in portrait.
// Registers an orientation listener and returns a cleanup function. No-op on web.
export function initFullScreenInLandscape(): () => void {
  if (!Capacitor.isNativePlatform()) return () => {}
  const mq = window.matchMedia('(orientation: landscape)')
  const apply = () => {
    (mq.matches ? StatusBar.hide() : StatusBar.show()).catch(() => {})
  }
  apply()
  mq.addEventListener('change', apply)
  return () => mq.removeEventListener('change', apply)
}
