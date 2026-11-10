// The lastGLANCE desktop shell: the main process. Design: docs/desktop-app.md.
//
// Phase 1 (section 12): the window, the app:// origin, the CSP, menus, external
// links, crash recovery and the startup log. The window, protocol and lifecycle
// code follows dayGLANCE's electron/main.ts (krelltunez/dayGLANCE@8d72008).

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, net, Notification, powerMonitor, protocol, safeStorage, screen, session, shell } from 'electron';
import dns from 'node:dns';
import crypto from 'node:crypto';
import fs from 'node:fs';
import nodeNet from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_BASE_URL, APP_HOST, APP_SCHEME, resolveAppRequest } from './appProtocol.js';
import { buildApplicationMenuTemplate, isApplicationMenuLabels, supportsCustomApplicationMenu, type ApplicationMenuLabels } from './applicationMenu.js';
import { CONTENT_SECURITY_POLICY } from './csp.js';
import { isAllowedExternalUrl } from './externalLinks.js';
import { createHttpProxy } from './httpProxy.js';
import { createNetworkTrust, type NetworkTrust } from './networkTrust.js';
import { decideRecovery } from './rendererRecovery.js';
import { createVaultSseReader } from './vaultSse.js';
import { createSecureStore, secureStorageUsable } from './secureStore.js';
import { registerDirectAccessHandlers } from './directAccess.js';
import { registerFilesHandlers } from './files.js';
import { createICloudStore } from './icloud.js';
import { execFile } from 'node:child_process';
import { initStartupLog, logStartup } from './startupLog.js';
import { shouldQuitOnAllWindowsClosed } from './startupQuit.js';
import { DESKTOP_INFO_ARG, encodeDesktopInfo } from './desktopInfo.js';
import { loadWindowState, onScreen, saveWindowState, saveWindowTheme, windowBackgroundColor } from './windowState.js';
import { createCommandQueue, type CommandSource } from './commandQueue.js';
import { DEEP_LINK_SCHEME, deepLinkFromArgv, deepLinkToken } from './deepLink.js';
import { createReminderScheduler, type ScheduledReminder } from './reminderScheduler.js';
import { applyOpenAtLogin, closeAction, launchedHidden, loadDesktopSettings, saveDesktopSettings, type DesktopSettings } from './backgroundMode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The app:// scheme as a real web origin, before ready (a no-op after it).
// standard+secure gives app://lastglance a stable origin and a secure context;
// fetch support lets the renderer load its own JSON (the locale bundles).
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

// One name and one userData folder for every build. Electron derives the
// default from package.json's lowercase `name`; the MAS bundle id must not move
// it either (section 3). The sandbox still puts the MAS copy in its container.
app.setName('lastGLANCE');
app.setPath('userData', path.join(app.getPath('appData'), 'lastGLANCE'));

initStartupLog(app.getPath('userData'));
logStartup(`main process module loaded, version ${app.getVersion()}`);
process.on('uncaughtException', (err) => {
  logStartup(`uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
});
process.on('unhandledRejection', (reason) => {
  logStartup(`unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
});

const DEV = !app.isPackaged;
const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'] ?? 'http://localhost:5183';
const APP_DIST_DIR = path.join(__dirname, '../dist');
const IS_MAC = process.platform === 'darwin';

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let didCreateMainWindow = false;
let mainRecoveryAttempts: number[] = [];
let applicationMenuSignature: string | null = null;
// The page's translated strings for the shell's own text (the `menu` block):
// the application menu, the tray, the background notice. English until the
// page sends them.
let shellLabels: Record<string, string> = {};
const label = (key: string, fallback: string): string => shellLabels[key] || fallback;
let desktopSettings: DesktopSettings = loadDesktopSettings(app.getPath('userData'));

// Null for a destroyed window, so callers need no isDestroyed() checks.
function live(win: BrowserWindow | null): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null;
}

function isMainWindowSender(sender: Electron.WebContents): boolean {
  return sender === live(mainWindow)?.webContents;
}

function openExternalSafe(url: string): void {
  if (isAllowedExternalUrl(url)) void shell.openExternal(url);
}

// The app itself: the Vite dev server in dev, app://lastglance (any path or
// query) when packaged. Everything else is an external navigation.
function isSameAppOrigin(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (DEV && parsed.origin === new URL(VITE_DEV_SERVER_URL).origin) return true;
    return parsed.protocol === `${APP_SCHEME}:` && parsed.host === APP_HOST;
  } catch {
    return false;
  }
}

function updateApplicationMenu(labels: ApplicationMenuLabels): void {
  if (!supportsCustomApplicationMenu(process.platform)) return;
  const signature = JSON.stringify(labels);
  if (signature === applicationMenuSignature) return;
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildApplicationMenuTemplate(labels, { devTools: DEV })));
  applicationMenuSignature = signature;
}

ipcMain.on('shell:set-menu-labels', (event, labels: unknown) => {
  if (!isMainWindowSender(event.sender) || !isApplicationMenuLabels(labels)) return;
  shellLabels = { ...labels };
  updateApplicationMenu(labels);
  onShellLabels();
});

// ── Background mode (docs/desktop-app.md, section 7) ────────────────────────
// The settings the page shows: keep running (Windows and Linux) and open at login.
function backgroundSettingsView() {
  return { keepRunning: desktopSettings.keepRunning, openAtLogin: desktopSettings.openAtLogin };
}

ipcMain.handle('shell:get-background-settings', (event) => {
  if (!isMainWindowSender(event.sender)) return null;
  return backgroundSettingsView();
});

ipcMain.handle('shell:set-background-settings', (event, patch: unknown) => {
  if (!isMainWindowSender(event.sender) || !patch || typeof patch !== 'object') return backgroundSettingsView();
  const p = patch as Record<string, unknown>;
  if (typeof p.keepRunning === 'boolean') desktopSettings = { ...desktopSettings, keepRunning: p.keepRunning };
  if (typeof p.openAtLogin === 'boolean' && p.openAtLogin !== desktopSettings.openAtLogin) {
    const applied = applyOpenAtLogin(p.openAtLogin, {
      platform: process.platform,
      setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
      configHome: process.env.XDG_CONFIG_HOME || path.join(app.getPath('home'), '.config'),
      exec: process.env.APPIMAGE || process.execPath,
    });
    if (applied) desktopSettings = { ...desktopSettings, openAtLogin: p.openAtLogin };
    else logStartup('open at login: could not be changed');
  }
  saveDesktopSettings(app.getPath('userData'), desktopSettings);
  onBackgroundSettingsChanged();
  return backgroundSettingsView();
});

// The first time closing hides the window on Windows or Linux, say so: the
// app is still running in the tray.
function noteFirstBackgroundHide(): void {
  if (IS_MAC || desktopSettings.backgroundNoticeShown) return;
  desktopSettings = { ...desktopSettings, backgroundNoticeShown: true };
  saveDesktopSettings(app.getPath('userData'), desktopSettings);
  if (!Notification.isSupported()) return;
  new Notification({
    title: label('backgroundTitle', 'lastGLANCE is still running'),
    body: label('backgroundBody', 'Reminders keep coming while the window is closed. Open lastGLANCE from the tray.'),
  }).show();
}

// ── The command queue (docs/desktop-app.md, section 10) ─────────────────────
// The tray's and the notifications' writes, applied by the page through the
// app's own handlers and acknowledged only once handled (commandQueue.ts).
const commands = createCommandQueue({
  file: path.join(app.getPath('userData'), 'commands.json'),
  newId: () => crypto.randomUUID(),
});

function queueCommand(action: string, payload: Record<string, unknown>, source: CommandSource): void {
  const command = commands.enqueue(action, payload, source);
  if (!command) return;
  logStartup(`command queued: ${action} from ${source}`);
  live(mainWindow)?.webContents.send('commands:queued');
}

ipcMain.handle('commands:take', (event) => (isMainWindowSender(event.sender) ? commands.take() : []));
ipcMain.handle('commands:ack', (event, ids: unknown) => {
  if (isMainWindowSender(event.sender)) commands.ack(ids);
});

// ── Deep links (docs/desktop-app.md, section 8) ─────────────────────────────
// A lastglance:// URL (or a reminder's click, or the tray) becomes the token
// the iOS shell stashes; the page pulls it with widget.consumeDeepLink, as it
// does on the phones (src/native/pendingDeepLink.ts).
let pendingDeepLink: string | null = null;
const coldStartLink = deepLinkFromArgv(process.argv);
if (coldStartLink) pendingDeepLink = deepLinkToken(coldStartLink);

/** Show the window and, with a token, have the page open it. */
function openToken(token: string | null): void {
  if (token) pendingDeepLink = token;
  if (!app.isReady()) return;
  showMainWindow();
  if (token) live(mainWindow)?.webContents.send('widget:deep-link');
}

function openDeepLinkUrl(url: unknown): void {
  const token = deepLinkToken(url);
  if (!token) { logStartup('deep link refused'); if (app.isReady()) showMainWindow(); return; }
  openToken(token);
}

// macOS hands URLs over as an event, possibly before the app is ready.
app.on('open-url', (event, url) => {
  event.preventDefault();
  openDeepLinkUrl(url);
});

ipcMain.handle('widget:consume-deep-link', (event) => {
  if (!isMainWindowSender(event.sender)) return { deepLink: null };
  const deepLink = pendingDeepLink;
  pendingDeepLink = null;
  return { deepLink };
});

// ── Reminders (docs/desktop-app.md, section 7) ──────────────────────────────
// The page's reminder diff schedules here (reminderScheduler.ts); main shows
// each one as a system notification when it is due. A click opens its target;
// on macOS its buttons are real ("Mark done" queues a completion). Windows and
// Linux get click-to-open only.
const shownNotifications = new Set<Notification>();

function showReminder(r: ScheduledReminder): void {
  if (!Notification.isSupported()) return;
  const actions = IS_MAC ? r.actions : [];
  const n = new Notification({ title: r.title, body: r.body, actions: actions.map((a) => ({ type: 'button' as const, text: a.title })) });
  // Held until it is answered: a notification collected early loses its handlers.
  shownNotifications.add(n);
  const done = () => { shownNotifications.delete(n); };
  n.on('click', () => { done(); openToken(r.open); });
  n.on('action', (_event, index) => {
    done();
    const action = actions[index];
    if (!action) return;
    if (action.command) queueCommand(action.command.action, action.command.payload, 'notification');
    if (action.open) openToken(action.open);
  });
  n.on('close', done);
  n.show();
  logStartup(`reminder ${r.id} shown`);
}

const reminders = createReminderScheduler({
  file: path.join(app.getPath('userData'), 'reminders.json'),
  fire: showReminder,
  log: logStartup,
});

ipcMain.handle('notifications:permission', (event) => {
  if (!isMainWindowSender(event.sender)) return { display: 'denied' };
  return { display: Notification.isSupported() ? 'granted' : 'denied' };
});
ipcMain.handle('notifications:schedule', (event, list: unknown) => (isMainWindowSender(event.sender) ? reminders.schedule(list) : 0));
ipcMain.handle('notifications:cancel', (event, ids: unknown) => { if (isMainWindowSender(event.sender)) reminders.cancel(ids); });
ipcMain.handle('notifications:pending', (event) => (isMainWindowSender(event.sender) ? reminders.pending() : []));

// The tray (section 7): refreshed when its labels or the settings change.
function refreshTray(): void { /* the tray arrives with the tray popup */ }

// Hooks for the tray and reminders (section 7).
function onShellLabels(): void { refreshTray(); }
function onBackgroundSettingsChanged(): void { refreshTray(); }

// The page's foreground kicks never fire for a hidden window, or on a resume
// with the window already up: tell it the machine woke or the window came back.
function sendWake(why: string): void {
  if (why !== 'show') reminders.rearm();
  live(mainWindow)?.webContents.send('shell:wake', why);
}

ipcMain.on('shell:set-theme', (event, dark: unknown) => {
  if (!isMainWindowSender(event.sender) || typeof dark !== 'boolean') return;
  saveWindowTheme(app.getPath('userData'), dark);
  live(mainWindow)?.setBackgroundColor(windowBackgroundColor(app.getPath('userData'), nativeTheme.shouldUseDarkColors));
});

// Escape leaves native fullscreen, which macOS does not do by itself. The
// renderer asks only for an Escape that closed nothing and was not typed into
// a field (src/hooks/useEscapeKey.ts). Works for F11 fullscreen on Windows and
// Linux too; a no-op when the window is not fullscreen.
ipcMain.on('shell:exit-fullscreen', (event) => {
  const w = live(mainWindow);
  if (!isMainWindowSender(event.sender) || !w?.isFullScreen()) return;
  w.setFullScreen(false);
});

// The page's lines for the log file (src/native/desktop.ts, desktopLog): what
// a sync tier did, so a report from a real Mac can be traced. Capped per
// session; a line is cut at 500 characters.
const RENDERER_LOG_LINES_PER_SESSION = 500;
let rendererLogLines = 0;
ipcMain.on('shell:log', (event, message: unknown) => {
  if (!isMainWindowSender(event.sender) || typeof message !== 'string') return;
  if (rendererLogLines >= RENDERER_LOG_LINES_PER_SESSION) return;
  rendererLogLines += 1;
  logStartup(`page: ${message.replace(/\s+/g, ' ').slice(0, 500)}${rendererLogLines === RENDERER_LOG_LINES_PER_SESSION ? ' (page log limit reached for this session)' : ''}`);
});

// ── Network (docs/desktop-app.md, section 4) ────────────────────────────────
// The renderer's only way out: WebDAV, GLANCEvault, intents and the roster all
// arrive here as `http:request`. networkTrust.ts decides which servers may be
// reached (a private address only once the user grants it); httpProxy.ts makes
// the request.

// Every A/AAAA record, so a public name with a private record is caught.
// dns.lookup goes through the OS resolver, which is what resolves Tailscale
// MagicDNS names (host.tailnet.ts.net).
async function resolveHostAddresses(host: string): Promise<string[]> {
  const bare = host.replace(/^\[|\]$/g, '');
  if (nodeNet.isIP(bare)) return [bare];
  return (await dns.promises.lookup(bare, { all: true })).map(({ address }) => address);
}

let networkTrust: NetworkTrust | null = null;
function trust(): NetworkTrust {
  networkTrust ??= createNetworkTrust({
    grantsFile: path.join(app.getPath('userData'), 'proxy-trusted-hosts.json'),
    resolve: resolveHostAddresses,
    confirm: async ({ title, message, detail, allow, cancel }) => {
      const options: Electron.MessageBoxOptions = {
        type: 'warning', buttons: [cancel, allow], defaultId: 0, cancelId: 0, title, message, detail,
      };
      const parent = live(mainWindow);
      const { response } = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      return response === 1;
    },
    log: logStartup,
  });
  return networkTrust;
}

const httpRequest = createHttpProxy({
  send: (url, init) => net.fetch(url, init),
  validate: (url, isRedirect) => trust().validate(url, isRedirect),
});

ipcMain.handle('http:request', (event, method: unknown, url: unknown, headers: unknown, body: unknown) => {
  if (!isMainWindowSender(event.sender)) return { error: 'Not allowed from this window' };
  return httpRequest(method, url, headers, body);
});

ipcMain.handle('http:inspect', (event, url: unknown) => {
  if (!isMainWindowSender(event.sender) || typeof url !== 'string') return { blocked: false };
  return trust().inspect(url);
});

// The only path to the permission dialog, called from the "Allow this
// address" button in Cloud Sync.
ipcMain.handle('http:grant', (event, url: unknown, labels: unknown) => {
  if (!isMainWindowSender(event.sender) || typeof url !== 'string') return { ok: false, reason: 'Invalid URL' };
  return trust().request(url, labels);
});

ipcMain.handle('http:grants', (event) => (isMainWindowSender(event.sender) ? trust().list() : []));

ipcMain.handle('http:revoke', (event, origin: unknown) => {
  if (!isMainWindowSender(event.sender) || typeof origin !== 'string') return { ok: false };
  return trust().revoke(origin);
});

// GLANCEvault's real-time push, read here and relayed to the renderer, which
// takes the same 'native-bridge' road as the phone shells (vaultSse.ts).
const vaultSse = createVaultSseReader({
  fetch: (url, init) => net.fetch(url, init),
  validate: (url) => trust().validate(url, false),
  push: (message) => {
    if (message.type === 'error') logStartup(`vault SSE: ${message.code ?? 'error'}: ${message.message}`);
    live(mainWindow)?.webContents.send('vault-sse:message', message);
  },
});

ipcMain.handle('vault-sse:start', (event, options: unknown) => {
  if (!isMainWindowSender(event.sender) || !options || typeof options !== 'object') return;
  const { vaultUrl, vaultToken, accountId } = options as Record<string, unknown>;
  if (typeof vaultUrl !== 'string' || typeof vaultToken !== 'string' || typeof accountId !== 'string') return;
  vaultSse.start({ vaultUrl, vaultToken, accountId });
});

ipcMain.handle('vault-sse:stop', (event) => {
  if (isMainWindowSender(event.sender)) vaultSse.stop();
});

// ── Secure storage (docs/desktop-app.md, section 5) ─────────────────────────
// The SecureStore contract over safeStorage. Asked only after ready, when
// safeStorage can answer; unusable (a Linux machine without a keyring) means
// the renderer keeps its web storage, as the phones' web build does.
function isSecureStorageUsable(): boolean {
  return secureStorageUsable(
    process.platform,
    safeStorage.isEncryptionAvailable(),
    process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : undefined,
  );
}

let secureStore: ReturnType<typeof createSecureStore> | null = null;
function store() {
  if (!isSecureStorageUsable()) throw new Error('Secure storage is not available');
  secureStore ??= createSecureStore({
    file: path.join(app.getPath('userData'), 'secure-store.json'),
    cipher: { encrypt: (plain) => safeStorage.encryptString(plain), decrypt: (cipher) => safeStorage.decryptString(cipher) },
  });
  return secureStore;
}

ipcMain.handle('secure-store:get', (event, key: unknown) => {
  if (!isMainWindowSender(event.sender)) return { value: null };
  return store().get(key);
});
ipcMain.handle('secure-store:set', (event, key: unknown, value: unknown) => {
  if (!isMainWindowSender(event.sender)) throw new Error('Not allowed from this window');
  store().set(key, value);
});
ipcMain.handle('secure-store:delete', (event, key: unknown) => {
  if (!isMainWindowSender(event.sender)) return;
  store().delete(key);
});

// Direct Access: a folder a sync tool keeps in step (directAccess.ts).
registerDirectAccessHandlers({ app, dialog, ipcMain, getWindow: () => live(mainWindow), isMainWindowSender, log: logStartup });

// ── iCloud Drive (docs/desktop-app.md, section 6) ───────────────────────────
// macOS only: the containers live under ~/Library/Mobile Documents, which no
// other platform has. Elsewhere every call answers "iCloud not available".
const brctlAskedAt = new Map<string, number>();
const icloud = process.platform === 'darwin'
  ? createICloudStore({
      home: app.getPath('home'),
      // Ask the iCloud daemon to fetch a cloud-only file, at most once a minute
      // per file. Best-effort: the Developer ID build only, since the MAS
      // sandbox would not let brctl reach the container.
      requestDownload: process.mas ? undefined : (abs) => {
        const last = brctlAskedAt.get(abs) ?? 0;
        if (Date.now() - last < 60_000) return;
        brctlAskedAt.set(abs, Date.now());
        execFile('/usr/bin/brctl', ['download', abs], () => { /* best-effort */ });
      },
    })
  : null;
const NO_ICLOUD = 'iCloud not available';

const icloudArgs = (options: unknown) => (options ?? {}) as { path?: unknown; container?: unknown; text?: unknown };
ipcMain.handle('icloud:available', (event) => (isMainWindowSender(event.sender) && icloud ? icloud.available() : { available: false }));
ipcMain.handle('icloud:read-file', (event, options: unknown) => {
  if (!isMainWindowSender(event.sender) || !icloud) return { kind: 'error', error: NO_ICLOUD };
  const { path: rel, container } = icloudArgs(options);
  return icloud.readFile(rel, container);
});
ipcMain.handle('icloud:write-file', (event, options: unknown) => {
  if (!isMainWindowSender(event.sender) || !icloud) return { ok: false, error: NO_ICLOUD };
  const { path: rel, container, text } = icloudArgs(options);
  return icloud.writeFile(rel, text, container);
});
ipcMain.handle('icloud:list-files', (event, options: unknown) => {
  if (!isMainWindowSender(event.sender) || !icloud) return { names: null };
  const { path: rel, container } = icloudArgs(options);
  return icloud.listFiles(rel, container);
});
ipcMain.handle('icloud:delete-file', (event, options: unknown) => {
  if (!isMainWindowSender(event.sender) || !icloud) return { ok: false, error: NO_ICLOUD };
  const { path: rel, container } = icloudArgs(options);
  return icloud.deleteFile(rel, container);
});
ipcMain.handle('icloud:make-dir', (event, options: unknown) => {
  if (!isMainWindowSender(event.sender) || !icloud) return { ok: false, error: NO_ICLOUD };
  const { path: rel, container } = icloudArgs(options);
  return icloud.makeDir(rel, container);
});

// Exports through the save dialog; the pre-restore copy into userData (files.ts).
registerFilesHandlers({
  ipcMain,
  dialog,
  getWindow: () => live(mainWindow),
  isMainWindowSender,
  downloadsDir: () => app.getPath('downloads'),
  backupsDir: () => path.join(app.getPath('userData'), 'backups'),
  log: logStartup,
});

function createWindow({ startHidden = false }: { startHidden?: boolean } = {}): BrowserWindow {
  const userData = app.getPath('userData');
  const saved = onScreen(loadWindowState(userData), screen.getAllDisplays().map((d) => d.workArea));
  didCreateMainWindow = true;
  logStartup('createWindow: called');

  const win = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    ...(saved.x != null && saved.y != null ? { x: saved.x, y: saved.y } : {}),
    show: false,
    backgroundColor: windowBackgroundColor(userData, nativeTheme.shouldUseDarkColors),
    // The app is phone-first, so a narrow window is a real layout, not a
    // broken one; this floor keeps the header and a card column usable.
    minWidth: 360,
    minHeight: 520,
    title: 'lastGLANCE',
    ...(IS_MAC ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 14, y: 14 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: DEV,
      // A hidden window keeps the 15 s sync polls and the reminder diff on
      // their cadence (section 7).
      backgroundThrottling: false,
      // The facts the preload exposes as bridge.info (desktopInfo.ts).
      additionalArguments: [
        `${DESKTOP_INFO_ARG}${encodeDesktopInfo({ version: app.getVersion(), isMAS: process.mas === true, secureStorage: isSecureStorageUsable() })}`,
      ],
    },
  });
  mainWindow = win;

  // The last non-maximized bounds, so a maximized window restores correctly.
  let normalBounds = { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
  const trackBounds = () => {
    const w = live(mainWindow);
    if (w && !w.isMaximized() && !w.isMinimized() && !w.isFullScreen()) normalBounds = w.getBounds();
  };
  win.on('resize', trackBounds);
  win.on('move', trackBounds);
  win.on('close', (event) => {
    saveWindowState(userData, { ...normalBounds, maximized: live(mainWindow)?.isMaximized() ?? false });
    if (closeAction({ platform: process.platform, isQuitting, keepRunning: desktopSettings.keepRunning }) === 'hide') {
      // Closing hides (backgroundMode.ts). Hiding a fullscreen window strands
      // its Space as a black screen on macOS, so leave fullscreen first.
      event.preventDefault();
      const w = live(mainWindow);
      if (!w) return;
      if (w.isFullScreen()) {
        w.once('leave-full-screen', () => live(mainWindow)?.hide());
        w.setFullScreen(false);
      } else {
        w.hide();
      }
      noteFirstBackgroundHide();
    }
  });
  win.on('show', () => sendWake('show'));

  if (saved.maximized) win.maximize();

  // Show after the first paint (no white frame), with a fallback so a renderer
  // that never paints still leaves a visible, reportable window.
  const SHOW_FALLBACK_MS = 10_000;
  let shown = false;
  const showOnce = (why: string) => {
    if (shown) return;
    shown = true;
    // An open-at-login start on Windows or Linux stays in the tray.
    if (startHidden) { logStartup(`main window kept hidden (${why}, started at login)`); return; }
    logStartup(`main window show (${why})`);
    live(mainWindow)?.show();
  };
  const fallbackShow = setTimeout(() => showOnce('fallback-timeout'), SHOW_FALLBACK_MS);
  win.once('ready-to-show', () => { clearTimeout(fallbackShow); showOnce('ready-to-show'); });

  win.webContents.on('did-finish-load', () => logStartup('main window did-finish-load'));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => logStartup(`did-fail-load: code=${code} "${desc}" url=${url}`));
  win.webContents.on('preload-error', (_e, preloadPath, err) => logStartup(`preload-error: ${preloadPath}: ${err?.message ?? err}`));

  // Crash recovery: reload, then recreate, then stop (rendererRecovery.ts).
  win.webContents.on('render-process-gone', (_e, details) => {
    logStartup(`render-process-gone: reason=${details.reason} exitCode=${details.exitCode}`);
    const decision = decideRecovery({ reason: details.reason, isQuitting, attempts: mainRecoveryAttempts, now: Date.now() });
    mainRecoveryAttempts = decision.attempts;
    if (decision.action === 'ignore' || decision.action === 'give-up') {
      if (decision.action === 'give-up') logStartup('crash recovery: giving up (crash loop)');
      return;
    }
    // Deferred so a crash a moment before quit sees the flag before-quit sets.
    setTimeout(() => {
      if (isQuitting) return;
      const w = live(mainWindow);
      if (!w) return;
      logStartup(`crash recovery: ${decision.action}`);
      if (decision.action === 'reload') w.webContents.reload();
      else if (decision.action === 'load-url') void w.loadURL(DEV ? VITE_DEV_SERVER_URL : APP_BASE_URL);
      else {
        w.destroy();
        createWindow();
      }
    }, 250);
  });

  // Links leave the app for the system browser or mail client; the renderer
  // never opens a second window and never navigates off its own origin.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isSameAppOrigin(url)) return;
    event.preventDefault();
    openExternalSafe(url);
  });

  if (DEV) {
    // Vite may not be up yet when concurrently starts Electron; keep retrying
    // a refused dev load. ERR_ABORTED (-3) is a superseded navigation.
    win.webContents.on('did-fail-load', (_e, code, _desc, url) => {
      if (code === -3 || !url?.startsWith(VITE_DEV_SERVER_URL)) return;
      setTimeout(() => { void live(mainWindow)?.loadURL(VITE_DEV_SERVER_URL); }, 1000);
    });
    void win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    void win.loadURL(APP_BASE_URL);
  }
  return win;
}

function showMainWindow(): void {
  const w = live(mainWindow);
  if (!w) { createWindow(); return; }
  if (w.isMinimized()) w.restore();
  if (!w.isVisible()) w.show();
  w.focus();
}

// One process at a time: a second launch focuses the first.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const url = deepLinkFromArgv(argv);
    if (url) openDeepLinkUrl(url);
    else showMainWindow();
  });
}

if (process.platform === 'win32') app.setAppUserModelId('com.lastglance.app');

app.setAboutPanelOptions({
  applicationName: 'lastGLANCE',
  applicationVersion: app.getVersion(),
  copyright: 'Copyright © 2026 GLANCE Apps',
  website: 'https://www.glance-apps.com/lastglance',
});

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;
  logStartup('app ready');

  // The CSP on every document the renderer loads over the network (dev), and
  // on the app:// document itself below: custom-scheme responses do not pass
  // through onHeadersReceived. The Vite dev server is left alone: the strict
  // policy blocks the react-refresh preamble and the HMR websocket.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (DEV && details.url.startsWith(VITE_DEV_SERVER_URL)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [CONTENT_SECURITY_POLICY] } });
  });

  // The renderer asks for nothing beyond notifications (the web reminder path
  // until section 7's scheduler) and clipboard writes (copy to clipboard).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'notifications' || permission === 'clipboard-sanitized-write');
  });

  // app://lastglance/... -> dist/, with SPA fallback (appProtocol.ts).
  protocol.handle(APP_SCHEME, async (request) => {
    const isFile = (p: string): boolean => {
      try { return fs.statSync(p).isFile(); } catch { return false; }
    };
    const resolved = resolveAppRequest(APP_DIST_DIR, request.url, isFile);
    if (resolved.status !== 200 || !resolved.filePath) {
      return new Response(resolved.status === 403 ? 'Forbidden' : 'Not found', {
        status: resolved.status,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    try {
      const data = await fs.promises.readFile(resolved.filePath);
      const headers: Record<string, string> = { 'Content-Type': resolved.contentType || 'application/octet-stream' };
      if (resolved.contentType?.startsWith('text/html')) headers['Content-Security-Policy'] = CONTENT_SECURITY_POLICY;
      return new Response(data, { status: 200, headers });
    } catch {
      return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  });

  // lastglance:// opens this app. A dev run registers the Electron binary
  // with the app's entry, as Windows and Linux need.
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }

  // A link that launched the app opens the window even at login.
  createWindow({ startHidden: !IS_MAC && launchedHidden(process.argv) && !pendingDeepLink });

  // Reminders due while the app was not running: within 12 hours fire once.
  reminders.rearm();
  app.on('will-quit', () => reminders.stop());

  // A woken machine or an unlocked screen: the page's foreground kicks
  // (section 7). Reminders re-arm on the same signals.
  powerMonitor.on('resume', () => sendWake('resume'));
  powerMonitor.on('unlock-screen', () => sendWake('unlock'));

  // A sync file changed in iCloud: run a cycle now rather than at the next poll.
  if (icloud) {
    const stopICloudWatch = icloud.watch(() => live(mainWindow)?.webContents.send('icloud:changed'));
    app.on('will-quit', stopICloudWatch);
  }

  app.on('activate', () => showMainWindow());
});

app.on('before-quit', () => {
  isQuitting = true;
  vaultSse.stop();
});

app.on('window-all-closed', () => {
  if (shouldQuitOnAllWindowsClosed(process.platform, didCreateMainWindow)) {
    logStartup('window-all-closed: quit');
    app.quit();
  }
});
