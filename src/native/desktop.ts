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
  /** One line in the app's log file (lastglance-startup.log), for support. */
  log(message: string): void
  /** Background mode (docs/desktop-app.md, section 7). keepRunning applies on Windows and Linux. */
  getBackgroundSettings(): Promise<DesktopBackgroundSettings | null>
  setBackgroundSettings(patch: Partial<DesktopBackgroundSettings>): Promise<DesktopBackgroundSettings>
  /** The machine woke, the screen unlocked, or the window was shown; returns the unsubscribe. */
  onWake(listener: (why: unknown) => void): () => void
  /** The OS clock (24-hour or not) and first day of the week (0 = Sunday); null where it cannot say. */
  systemFormats(): Promise<{ hour24: boolean | null; weekStart: number | null }>
}

export interface DesktopBackgroundSettings {
  keepRunning: boolean
  openAtLogin: boolean
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

/**
 * iCloud Drive on macOS (electron/icloud.ts): the ICloudPluginType of
 * src/native/icloud.ts, as the iOS shell implements it, with `onChanged` for
 * its "changed" event. Off macOS `available` is false.
 */
export interface DesktopICloud {
  available(): Promise<{ available: boolean }>
  readFile(options: { path: string; container?: string; allowStale?: boolean }): Promise<DirectAccessReadResult>
  writeFile(options: { path: string; text: string; container?: string; atomic?: boolean }): Promise<{ ok: boolean; error?: string }>
  listFiles(options: { path: string; container?: string }): Promise<{ names: string[] | null }>
  deleteFile(options: { path: string; container?: string }): Promise<{ ok: boolean }>
  makeDir(options: { path: string; container?: string }): Promise<{ ok: boolean }>
  onChanged(listener: () => void): () => void
}

/** A reminder as the main process schedules it (electron/reminderScheduler.ts). */
export interface DesktopReminder {
  id: number
  title: string
  body: string
  at: number
  /** The deep-link token a click opens. */
  open: string | null
  actions: { id: string; title: string; open?: string; command?: { action: string; payload: Record<string, unknown> } }[]
  extra: Record<string, unknown>
}

/** The reminder scheduler in main (docs/desktop-app.md, section 7). */
export interface DesktopNotifications {
  checkPermissions(): Promise<{ display: string }>
  schedule(list: DesktopReminder[]): Promise<number>
  cancel(ids: number[]): Promise<void>
  pending(): Promise<DesktopReminder[]>
}

/** The widget plugin's desktop half: the snapshot the tray shows, and deep links. */
export interface DesktopWidget {
  /** The widget snapshot (src/native/snapshot.ts), as the phones' widgets get it. */
  updateSnapshot(json: string): void
  consumeDeepLink(): Promise<{ deepLink: string | null }>
  /** A deep link is waiting; returns the unsubscribe. */
  onDeepLink(listener: () => void): () => void
}

/** A due chore as the tray shows it (electron/trayModel.ts). */
export interface DesktopTrayChore {
  syncId: string
  name: string
  icon: string | null
  categoryName: string | null
  state: 'overdue' | 'soon'
  lastCompletedAt: string | null
  elapsedDays: number | null
  targetCadenceDays: number | null
  ratio: number | null
  color: string | null
}

/** The snapshot's Reach out row (src/native/peopleSnapshot.ts). */
export interface DesktopTrayPerson {
  syncId: string
  name: string
  ratio: number | null
  color: string
  detail: string
}

/** The snapshot's Coming up row; `on` is the local day, YYYY-MM-DD. */
export interface DesktopTrayDate {
  personSyncId: string
  name: string
  label: string
  on: string
}

export interface DesktopTrayState {
  due: DesktopTrayChore[]
  counts: { overdue: number; soon: number }
  reachOut: DesktopTrayPerson[]
  comingUp: DesktopTrayDate[]
  ready: boolean
}

/** The tray popup's calls (src/tray/); main answers them only from the popup window. */
export interface DesktopTray {
  state(): Promise<DesktopTrayState | null>
  complete(syncId: string): void
  /** Show the app, at `chore:<id>`, `person:<id>`, `log:<id>` or `people` when given one it shows. */
  open(token: string | null): void
  hide(): void
  onState(listener: (state: unknown) => void): () => void
}

/** A write from outside the window (electron/commandQueue.ts): handleIntent's vocabulary. */
export interface DesktopCommand {
  clientId: string
  action: string
  payload: Record<string, unknown>
  source: 'tray' | 'notification'
  at: string
}

/** The command queue (docs/desktop-app.md, section 10): taken, applied, then acknowledged. */
export interface DesktopCommands {
  take(): Promise<DesktopCommand[]>
  ack(ids: string[]): Promise<void>
  /** A command was queued; returns the unsubscribe. */
  onQueued(listener: () => void): () => void
}

export interface DesktopBridge {
  info: DesktopInfo
  shell: DesktopShell
  http: DesktopHttp
  vaultSse: DesktopVaultSse
  secureStore: DesktopSecureStore
  directAccess: DesktopDirectAccess
  files: DesktopFiles
  icloud: DesktopICloud
  commands: DesktopCommands
  notifications: DesktopNotifications
  widget: DesktopWidget
  tray: DesktopTray
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
  'shell.log',
  'shell.getBackgroundSettings',
  'shell.setBackgroundSettings',
  'shell.onWake',
  'shell.systemFormats',
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
  'icloud.available',
  'icloud.readFile',
  'icloud.writeFile',
  'icloud.listFiles',
  'icloud.deleteFile',
  'icloud.makeDir',
  'icloud.onChanged',
  'commands.take',
  'commands.ack',
  'commands.onQueued',
  'notifications.checkPermissions',
  'notifications.schedule',
  'notifications.cancel',
  'notifications.pending',
  'widget.updateSnapshot',
  'widget.consumeDeepLink',
  'widget.onDeepLink',
  'tray.state',
  'tray.complete',
  'tray.open',
  'tray.hide',
  'tray.onState',
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

/** A line in the desktop app's log file; a no-op anywhere else. Never throws. */
export function desktopLog(message: string): void {
  try { desktopBridge()?.shell.log?.(message) } catch { /* best-effort */ }
}
