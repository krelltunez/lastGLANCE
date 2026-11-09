// The Electron desktop shell's bridge, as the renderer sees it
// (docs/desktop-app.md, section 2). The shell's preload (electron/preload.cts)
// exposes one object, `window.lastGlanceDesktop`; on web, Android and iOS there
// is none and `desktopBridge()` is null.
//
// The desktop app is not a Capacitor shell: `Capacitor.isNativePlatform()` and
// `isNativeShell()` stay false there, and each module that needs the shell
// asks `desktopBridge()` explicitly, as modules ask `headlessBridge()` for the
// Android headless refresh. The bridge grows one group per phase, each group
// shaped like the plugin contract it stands in for.

export type DesktopPlatform = 'darwin' | 'win32' | 'linux'

export interface DesktopInfo {
  platform: DesktopPlatform
  /** The desktop app's version (package.json). */
  version: string
  /** The Mac App Store build: sandboxed, and the only gated desktop build. */
  isMAS: boolean
}

export interface DesktopShell {
  /** The translated Windows/Linux application menu (macOS keeps the native one). */
  setMenuLabels(labels: Record<string, string>): void
  /** The resolved theme, so the next launch's window paints the right color first. */
  setTheme(dark: boolean): void
  /** Leave native fullscreen; a no-op when the window is not fullscreen. */
  exitFullscreen(): void
}

export interface DesktopBridge {
  info: DesktopInfo
  shell: DesktopShell
}

/**
 * Every bridge method, as `group.method`. The allowlist that
 * electron/bridgeContract.test.ts holds equal to the preload's exposure and to
 * the interfaces above, as HEADLESS_BRIDGE_METHODS is held to HeadlessBridge.kt.
 */
export const DESKTOP_BRIDGE_METHODS = [
  'shell.setMenuLabels',
  'shell.setTheme',
  'shell.exitFullscreen',
] as const

declare global {
  interface Window {
    lastGlanceDesktop?: unknown
  }
}

const PLATFORMS: readonly string[] = ['darwin', 'win32', 'linux']

function isDesktopBridge(value: unknown): value is DesktopBridge {
  if (!value || typeof value !== 'object') return false
  const b = value as Partial<DesktopBridge>
  return !!b.info && PLATFORMS.includes(b.info.platform as string) && typeof b.shell?.setTheme === 'function'
}

/** The desktop shell's bridge, or null anywhere else (web, PWA, Android, iOS). */
export function desktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null
  const candidate = window.lastGlanceDesktop
  return isDesktopBridge(candidate) ? candidate : null
}

export function isDesktop(): boolean {
  return desktopBridge() !== null
}

export function isDesktopMac(): boolean {
  return desktopBridge()?.info.platform === 'darwin'
}
