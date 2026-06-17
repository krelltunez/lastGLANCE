import { Capacitor } from '@capacitor/core'
import { StatusBar, Style } from '@capacitor/status-bar'

// Status bar background colors, matched to the app's Tailwind root backgrounds
// (dark:bg-slate-950 / bg-slate-50) so the bar blends into the header.
const DARK_BG = '#020617' // slate-950
const LIGHT_BG = '#f8fafc' // slate-50

// Sync the native status bar with the app's light/dark theme. No-op in the
// browser/PWA, and any plugin error is swallowed (non-fatal cosmetic concern).
export async function applyStatusBarTheme(isDark: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return
  try {
    // Style.Dark = light icons (for a dark bar); Style.Light = dark icons.
    await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light })
    // Background color is Android-only; on iOS the bar tracks the web content.
    if (Capacitor.getPlatform() === 'android') {
      await StatusBar.setBackgroundColor({ color: isDark ? DARK_BG : LIGHT_BG })
    }
  } catch {
    // Plugin unavailable or transient failure — leave the OS default.
  }
}
