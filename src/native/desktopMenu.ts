import type { i18n as I18n } from 'i18next'
import type { DesktopBridge } from './desktop'

// The desktop app's Windows/Linux application menu speaks the app's language
// (docs/desktop-app.md, section 5, Window chrome), after dayGLANCE's
// applicationMenuLabels. The strings are the `menu` block of the locale bundles;
// main keeps Electron's default menu until a complete set arrives
// (electron/applicationMenu.ts, isApplicationMenuLabels), and macOS ignores
// them, its native menu being localized by the OS.

/** The current language's `menu` strings, or null before they have loaded. */
export function menuLabels(i18n: Pick<I18n, 't'>): Record<string, string> | null {
  const labels: unknown = i18n.t('menu', { returnObjects: true })
  if (!labels || typeof labels !== 'object' || Array.isArray(labels)) return null
  const entries = Object.entries(labels as Record<string, unknown>)
  if (entries.length === 0 || entries.some(([, v]) => typeof v !== 'string')) return null
  return Object.fromEntries(entries) as Record<string, string>
}

/** Push the labels now (if loaded), and again on every language change. */
export function syncDesktopMenuLabels(i18n: I18n, bridge: Pick<DesktopBridge, 'shell'>): void {
  const push = () => {
    const labels = menuLabels(i18n)
    if (labels) bridge.shell.setMenuLabels(labels)
  }
  i18n.on('initialized', push)
  i18n.on('languageChanged', push)
  if (i18n.isInitialized) push()
}
