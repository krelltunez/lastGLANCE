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
  /** The OS protects secrets here; false on Linux without a keyring. */
  secureStorage: boolean
}

export interface DesktopShell {
  /** The translated Windows/Linux application menu (macOS keeps the native one). */
  setMenuLabels(labels: Record<string, string>): void
  /** The resolved theme, so the next launch's window paints the right color first. */
  setTheme(dark: boolean): void
  /** Leave native fullscreen; a no-op when the window is not fullscreen. */
  exitFullscreen(): void
}

/** A response from the main process, or why no response came (refused, timeout, network). */
export type DesktopHttpResult =
  | { status: number; statusText: string; body: string; headers: Record<string, string> }
  | { error: string }

/** Whether the main process will refuse a URL, and whether a grant could unlock it. */
export type DesktopHttpInspect =
  | { blocked: false }
  | { blocked: true; canGrant: true; origin: string; addresses: string[] }
  | { blocked: true; canGrant: false; origin: string; reason: string }

export interface DesktopHttpGrant {
  origin: string
  grantedAt: string
  addresses: string[]
}

/**
 * The renderer's HTTP (docs/desktop-app.md, section 4), made by the main
 * process with no CORS. A private network address is refused until the user
 * grants its origin through `grant`, which shows a native confirmation.
 */
export interface DesktopHttp {
  request(method: string, url: string, headers: Record<string, string>, body: string | null): Promise<DesktopHttpResult>
  inspect(url: string): Promise<DesktopHttpInspect>
  /** The permission dialog; `labels` is its translated text. */
  grant(url: string, labels: Record<string, string>): Promise<{ ok: boolean; reason?: string }>
  grants(): Promise<DesktopHttpGrant[]>
  revoke(origin: string): Promise<{ ok: boolean }>
}

/**
 * GLANCEvault's real-time push, read by the main process: the VaultSse
 * contract of src/native/vaultSse.ts, as the phone shells implement it.
 */
export interface DesktopVaultSse {
  start(options: { vaultUrl: string; vaultToken: string; accountId: string }): Promise<void>
  stop(): Promise<void>
  /** Every reader message ({type:'open'|'frame'|'closed'|'error'}); returns the unsubscribe. */
  onMessage(listener: (message: unknown) => void): () => void
}

/** The SecureStore contract of src/native/secureStore.ts, over Electron's safeStorage. */
export interface DesktopSecureStore {
  get(options: { key: string }): Promise<{ value: string | null }>
  set(options: { key: string; value: string }): Promise<void>
  delete(options: { key: string }): Promise<void>
}

type DirectAccessReadResult = { kind: 'absent' | 'downloading' | 'error' | 'text'; text?: string; error?: string }
type DirectAccessFolderStatus = { configured: boolean; name: string | null; path: string | null; reachable: boolean }

/**
 * Direct Access: the ANDROID folder contract of src/native/directAccess.ts
 * (electron/directAccess.ts), plus a change event from the folder watcher.
 */
export interface DesktopDirectAccess {
  status(): Promise<DirectAccessFolderStatus>
  pickFolder(): Promise<DirectAccessFolderStatus | { cancelled: true }>
  disconnect(): Promise<void>
  read(): Promise<DirectAccessReadResult>
  write(options: { text: string }): Promise<{ ok: boolean }>
  deleteFile(): Promise<{ ok: boolean }>
  listFiles(options: { rel: string }): Promise<{ names: string[] | null }>
  readFile(options: { rel: string }): Promise<DirectAccessReadResult>
  writeFile(options: { rel: string; text: string }): Promise<{ ok: boolean }>
  deleteFileAt(options: { rel: string }): Promise<{ ok: boolean }>
  makeDir(options: { rel: string }): Promise<{ ok: boolean }>
  /** The folder's snapshot or People file changed on disk; returns the unsubscribe. */
  onChanged(listener: () => void): () => void
}

/** Exports and the pre-restore copy (src/utils/exportFile.ts; electron/files.ts). */
export interface DesktopFiles {
  /** The native save dialog; `saved` is false when the user cancelled. */
  saveText(options: { filename: string; text: string }): Promise<{ saved: boolean }>
  /** Written silently to the app's backups folder. */
  stash(options: { filename: string; text: string }): Promise<void>
}

export interface DesktopBridge {
  info: DesktopInfo
  shell: DesktopShell
  http: DesktopHttp
  vaultSse: DesktopVaultSse
  secureStore: DesktopSecureStore
  directAccess: DesktopDirectAccess
  files: DesktopFiles
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
  'http.request',
  'http.inspect',
  'http.grant',
  'http.grants',
  'http.revoke',
  'vaultSse.start',
  'vaultSse.stop',
  'vaultSse.onMessage',
  'secureStore.get',
  'secureStore.set',
  'secureStore.delete',
  'directAccess.status',
  'directAccess.pickFolder',
  'directAccess.disconnect',
  'directAccess.read',
  'directAccess.write',
  'directAccess.deleteFile',
  'directAccess.listFiles',
  'directAccess.readFile',
  'directAccess.writeFile',
  'directAccess.deleteFileAt',
  'directAccess.makeDir',
  'directAccess.onChanged',
  'files.saveText',
  'files.stash',
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
