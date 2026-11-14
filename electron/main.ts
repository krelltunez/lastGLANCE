// The lastGLANCE desktop shell: the main process. Design: docs/desktop-app.md.
//
// Phase 1 (section 12): the window, the app:// origin, the CSP, menus, external
// links, crash recovery and the startup log. The window, protocol and lifecycle
// code follows dayGLANCE's electron/main.ts (krelltunez/dayGLANCE@8d72008).

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, powerMonitor, protocol, safeStorage, screen, session, shell, systemPreferences, Tray } from 'electron';
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
import { bindErrorCode, startMcpServer } from './mcpServer.js';
import { createRendererBridge } from './mcpRendererBridge.js';
import { createJournal } from './mcpJournal.js';
import { discoveryFilePath, syncDiscoveryFile } from './mcpDiscovery.js';
import { startStreamDeckServer, type StreamDeckServer } from './streamDeckServer.js';
import { deckCompletion, deckOpenToken, deckState, prunePresses } from './deckModel.js';
import { STREAM_DECK_PORT } from './deckProtocol.js';
import { registerElectronBilling } from '@glance-apps/billing/electron-main';
import { MAS_BILLING } from './billingConfig.js';
import { availableUpdate, CHECK_CACHE_MS, RELEASES_API, type AvailableUpdate } from './updateCheck.js';
import { DEEP_LINK_SCHEME, deepLinkFromArgv, deepLinkToken } from './deepLink.js';
import { createReminderScheduler, type ScheduledReminder } from './reminderScheduler.js';
import { isClickAfterBlurHide, parseTraySnapshot, popupPosition, settledCompletions, trayMenuItems, trayOpenToken, trayState, type TraySnapshot } from './trayModel.js';
import { linuxFormats, macFormats, windowsFormats, type SystemFormats } from './systemFormats.js';
import type http from 'node:http';
import { createIdempotencyStore, createWriteGate, type HostBridge } from '@glance-apps/mcp-host';
import {
  applyTransition, DEFAULT_LOCAL_INTEGRATIONS, integrationsView, listenerEffects, loadLocalIntegrations, mcpGates, mcpPort, saveLocalIntegrations,
  type ListenerStatus, type LocalIntegrationsConfig, type McpEffect, type StreamDeckEffect,
} from './localIntegrations.js';
import { applyOpenAtLogin, closeAction, isAcceleratorText, launchedHidden, loadDesktopSettings, saveDesktopSettings, type DesktopSettings } from './backgroundMode.js';

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

// ── The tray (docs/desktop-app.md, section 7) ───────────────────────────────
// A widget: it shows the snapshot the main window pushes and never opens the
// database (trayModel.ts). macOS gets a menu bar icon and Windows a tray icon,
// each with a popup (app://lastglance/?tray=1, src/tray/); Linux gets a menu
// only, since AppIndicator does not deliver clicks reliably there.
let tray: Tray | null = null;
let trayWindow: BrowserWindow | null = null;
let traySnapshot: TraySnapshot | null = null;
const doneHere = new Map<string, number>();
// When blur last hid the popup (the Windows click race, isClickAfterBlurHide).
let lastTrayBlurHideAt: number | null = null;
const TRAY_POPUP_SIZE = { width: 380, height: 560 };
const USE_TRAY_POPUP = process.platform !== 'linux';

function isTrayWindowSender(sender: Electron.WebContents): boolean {
  return sender === live(trayWindow)?.webContents;
}

function currentTrayState() {
  return { ...trayState(traySnapshot, doneHere), assistant: currentIntegrationsView().assistant };
}

function trayIconPath(name: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tray', name)
    : path.join(__dirname, '..', 'electron', 'resources', 'tray', name);
}

function trayMenuLabels() {
  return {
    open: label('trayOpen', 'Open lastGLANCE'),
    quit: label('trayQuit', 'Quit lastGLANCE'),
    markDone: label('trayMarkDone', 'Mark done'),
    nothingDue: label('trayNothingDue', 'Nothing due'),
  };
}

/**
 * The assistant's items, while the MCP server is on or there is something to
 * undo: undo everything assistants changed this session, and turn the server
 * off, without opening the window (docs/mcp-and-stream-deck.md, 4.5).
 */
function mcpTrayItems(): Electron.MenuItemConstructorOptions[] {
  const changes = mcpJournal.entries().length;
  const bound = mcpGates(integrationsConfig).bound;
  if (!bound && changes === 0) return [];
  return [
    ...(changes > 0 ? [{ label: `${label('trayMcpUndo', 'Undo assistant changes')} (${changes})`, click: () => { void undoMcpWrites(); } }] : []),
    ...(bound ? [{ label: label('trayMcpOff', 'Turn off assistant access'), click: () => { runIntegrationsTransition({ type: 'set-mcp-read-tier', tier: 'off' }); } }] : []),
    { type: 'separator' },
  ];
}

function trayMenu(withChores: boolean): Menu {
  const items = trayMenuItems(currentTrayState(), trayMenuLabels(), withChores);
  return Menu.buildFromTemplate([...mcpTrayItems(), ...items.map((item): Electron.MenuItemConstructorOptions => {
    switch (item.kind) {
      case 'open': return { label: item.label, click: () => showMainWindow() };
      case 'quit': return { label: item.label, click: () => app.quit() };
      case 'empty': return { label: item.label, enabled: false };
      case 'chore': return {
        label: item.label,
        submenu: [
          { label: item.markDone, click: () => completeFromTray(item.syncId) },
          { label: item.open, click: () => openToken(`chore:${item.syncId}`) },
        ],
      };
      default: return { type: 'separator' };
    }
  })]);
}

function refreshTray(): void {
  if (!tray || tray.isDestroyed()) return;
  const { counts } = currentTrayState();
  tray.setToolTip(counts.overdue > 0 ? `lastGLANCE · ${counts.overdue}` : 'lastGLANCE');
  if (!USE_TRAY_POPUP) tray.setContextMenu(trayMenu(true));
  live(trayWindow)?.webContents.send('tray:state', currentTrayState());
  // The deck draws the same snapshot: a new one, or a completion from the tray, reaches its keys too.
  streamDeckServer?.broadcast();
}

function completeFromTray(syncId: unknown): void {
  if (typeof syncId !== 'string' || !traySnapshot?.chores.some((c) => c.syncId === syncId)) return;
  doneHere.set(syncId, Date.now());
  queueCommand('complete', { chore_id: syncId }, 'tray');
  refreshTray();
}

function createTrayWindow(): BrowserWindow {
  const w = new BrowserWindow({
    ...TRAY_POPUP_SIZE,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: windowBackgroundColor(app.getPath('userData'), nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: DEV,
      additionalArguments: [
        `${DESKTOP_INFO_ARG}${encodeDesktopInfo({ version: app.getVersion(), isMAS: process.mas === true, secureStorage: isSecureStorageUsable() })}`,
      ],
    },
  });
  trayWindow = w;
  w.on('blur', () => {
    if (DEV && w.webContents.isDevToolsOpened()) return;
    if (w.isVisible()) lastTrayBlurHideAt = Date.now();
    w.hide();
  });
  w.webContents.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: 'deny' }; });
  w.webContents.on('will-navigate', (event) => event.preventDefault());
  w.webContents.on('render-process-gone', (_e, details) => {
    logStartup(`tray render-process-gone: reason=${details.reason}`);
    if (!isQuitting && live(trayWindow) === w) { w.destroy(); trayWindow = null; }
  });
  void w.loadURL(`${DEV ? VITE_DEV_SERVER_URL : APP_BASE_URL}?tray=1`);
  return w;
}

function toggleTrayPopup(fromIconClick = false): void {
  if (!tray) return;
  const w = live(trayWindow) ?? createTrayWindow();
  if (w.isVisible()) { w.hide(); return; }
  // Windows: the click that just blurred the popup closed is this click.
  if (fromIconClick && process.platform === 'win32' && isClickAfterBlurHide(Date.now(), lastTrayBlurHideAt)) return;
  const icon = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: icon.x, y: icon.y });
  w.setPosition(...Object.values(popupPosition(icon, TRAY_POPUP_SIZE, display.workArea)) as [number, number]);
  w.webContents.send('tray:state', currentTrayState());
  w.show();
  w.focus();
  // The popup puts the cursor in its search field (src/tray/TrayPopup.tsx).
  w.webContents.send('tray:shown');
}

function createTray(): void {
  const image = IS_MAC
    ? nativeImage.createFromPath(trayIconPath('trayTemplate.png'))
    : nativeImage.createFromPath(trayIconPath('tray@2x.png'));
  if (IS_MAC) image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip('lastGLANCE');
  if (USE_TRAY_POPUP) {
    tray.on('click', () => toggleTrayPopup(true));
    tray.on('right-click', () => tray?.popUpContextMenu(trayMenu(false)));
  }
  refreshTray();
}

// ── Global shortcuts (docs/desktop-app.md, section 7) ──────────────────────
// Two, both off until the user records one in Settings: open the popup (to
// search and log a chore) and show the window. Kept in desktop-settings.json
// and registered here at launch, so they work before the page has loaded. The
// popup exists on macOS and Windows; Linux has the window shortcut only. A
// shortcut another app already holds cannot be registered, and the page says so.
type ShortcutKind = 'popup' | 'window';
const shortcutHandlers: Record<ShortcutKind, () => void> = {
  popup: () => toggleTrayPopup(),
  window: () => showMainWindow(),
};
const registeredShortcuts: Record<ShortcutKind, string> = { popup: '', window: '' };

/** Register (or clear, with '') one shortcut. The old one stays if the new one cannot be had. */
function applyShortcut(kind: ShortcutKind, accelerator: string): boolean {
  if (kind === 'popup' && !USE_TRAY_POPUP && accelerator) return false;
  if (accelerator === registeredShortcuts[kind]) return true;
  if (accelerator) {
    let ok = false;
    try { ok = globalShortcut.register(accelerator, shortcutHandlers[kind]); } catch { ok = false; }
    if (!ok) { logStartup(`global shortcut ${accelerator} (${kind}) could not be registered`); return false; }
  }
  if (registeredShortcuts[kind]) {
    try { globalShortcut.unregister(registeredShortcuts[kind]); } catch { /* already gone */ }
  }
  registeredShortcuts[kind] = accelerator;
  return true;
}

function shortcutsView() {
  return { popup: registeredShortcuts.popup, window: registeredShortcuts.window, popupSupported: USE_TRAY_POPUP };
}

ipcMain.handle('shell:get-shortcuts', (event) => (isMainWindowSender(event.sender) ? shortcutsView() : null));
ipcMain.handle('shell:set-shortcut', (event, kind: unknown, accelerator: unknown) => {
  if (!isMainWindowSender(event.sender) || (kind !== 'popup' && kind !== 'window')) return { ok: false, ...shortcutsView() };
  if (accelerator !== '' && !isAcceleratorText(accelerator)) return { ok: false, ...shortcutsView() };
  const ok = applyShortcut(kind, accelerator as string);
  if (ok) {
    desktopSettings = { ...desktopSettings, [kind === 'popup' ? 'popupShortcut' : 'windowShortcut']: accelerator as string };
    saveDesktopSettings(app.getPath('userData'), desktopSettings);
  }
  return { ok, ...shortcutsView() };
});

// ── Local integrations (docs/mcp-and-stream-deck.md, section 3) ────────────
// The MCP server and the Stream Deck listener, both off until turned on in
// Settings. localIntegrations.ts decides; this applies. The Stream Deck
// listener arrives in phase 5: until then its effect is only logged.
let integrationsConfig: LocalIntegrationsConfig = DEFAULT_LOCAL_INTEGRATIONS;
const integrationsStatus: { mcp: ListenerStatus; streamDeck: ListenerStatus } = {
  mcp: { running: false, error: null },
  streamDeck: { running: false, error: null },
};

function currentIntegrationsView() {
  return integrationsView(integrationsConfig, integrationsStatus, { writesPaused: mcpGate.writesDisabled(), undoable: mcpJournal.entries().length });
}

function pushIntegrationsStatus(): void {
  live(mainWindow)?.webContents.send('local-integrations:status', currentIntegrationsView());
  // The tray popup's indicator and the menu's assistant items follow it.
  refreshTray();
}

// The MCP listener (mcpServer.ts). The bridge to the page is made once and
// kept across stops and starts; the token and the People tier are read on
// every request, so neither needs a restart.
let mcpServerHandle: http.Server | null = null;
let mcpBridge: HostBridge | null = null;
// Writes (4.5): made once and kept across stops and starts, so turning the
// server off and on cannot reset the rate limit or the replay window. The
// journal is the session's: a restart clears it.
const mcpGate = createWriteGate();
const mcpStore = createIdempotencyStore<Record<string, unknown>>();
const mcpJournal = createJournal();

function pushJournal(): void {
  live(mainWindow)?.webContents.send('mcp-journal:changed', mcpJournal.snapshot());
  pushIntegrationsStatus();
}

/** Undo one item's changes, or all of them, newest first, through the page. */
async function undoMcpWrites(groupKey?: string): Promise<{ ok: boolean; undone?: number; skipped?: unknown[]; error?: string }> {
  const { ops, seqs } = mcpJournal.plan(groupKey);
  if (ops.length === 0) return { ok: true, undone: 0, skipped: [] };
  mcpBridge ??= createRendererBridge(() => live(mainWindow));
  const r = await mcpBridge.request('undo_mcp_writes', { ops }, 10_000);
  if (!r.ok) return { ok: false, error: r.error.code };
  mcpJournal.remove(seqs);
  pushJournal();
  const data = (r.data ?? {}) as { undone?: number; skipped?: unknown[] };
  logStartup(`mcp undo: ${data.undone ?? 0} undone, ${data.skipped?.length ?? 0} kept`);
  return { ok: true, undone: data.undone ?? 0, skipped: data.skipped ?? [] };
}

// The discovery file (mcpDiscovery.ts): where the bridge finds the port and
// token. Written while the server runs, kept current, removed when it stops;
// never on the Mac App Store build.
const MCP_DISCOVERY_FILE = discoveryFilePath(process.platform, process.env, app.getPath('home'), process.mas === true);

function updateDiscoveryFile(): void {
  const running = integrationsStatus.mcp.running && mcpGates(integrationsConfig).bound;
  const failure = syncDiscoveryFile(MCP_DISCOVERY_FILE, running ? { port: mcpPort(integrationsConfig), token: integrationsConfig.mcp.token ?? '' } : null);
  if (failure) logStartup(`mcp discovery file not updated: ${failure}`);
}

function setMcpStatus(status: ListenerStatus): void {
  integrationsStatus.mcp = status;
  updateDiscoveryFile();
  pushIntegrationsStatus();
}

function startMcpListener(): void {
  if (mcpServerHandle || !mcpGates(integrationsConfig).bound) return;
  mcpBridge ??= createRendererBridge(() => live(mainWindow));
  const srv = startMcpServer({
    token: () => integrationsConfig.mcp.token ?? '',
    portOverride: integrationsConfig.mcp.portOverride,
    version: app.getVersion(),
    readDeps: {
      bridge: mcpBridge,
      now: () => Date.now(),
      timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      includePeople: () => mcpGates(integrationsConfig).includePeople,
    },
    writeDeps: {
      bridge: mcpBridge,
      gate: mcpGate,
      store: mcpStore,
      token: () => integrationsConfig.mcp.token ?? '',
      includeWrites: () => mcpGates(integrationsConfig).includeWrites,
      includePeople: () => mcpGates(integrationsConfig).includePeople,
      onWritesDisabled: () => {
        logStartup('mcp: writes turned off after repeated rate-limit overruns, until restart');
        pushIntegrationsStatus();
      },
      journal: mcpJournal,
      onWrite: pushJournal,
      timeZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    log: logStartup,
    logError: logStartup,
  });
  if (!srv) { setMcpStatus({ running: false, error: 'bind_failed' }); return; }
  mcpServerHandle = srv;
  srv.on('listening', () => { if (mcpServerHandle === srv) setMcpStatus({ running: true, error: null }); });
  srv.on('error', (err) => {
    if (mcpServerHandle !== srv) return;
    mcpServerHandle = null;
    try { srv.close(); } catch { /* never bound */ }
    setMcpStatus({ running: false, error: bindErrorCode(err) });
  });
}

/** Stop and free the port at once, so a restart on the same port does not race its own rebind. */
function stopMcpListener(onClosed?: () => void): void {
  const srv = mcpServerHandle;
  mcpServerHandle = null;
  integrationsStatus.mcp = { running: false, error: null };
  updateDiscoveryFile();
  if (!srv) { onClosed?.(); return; }
  srv.close(() => onClosed?.());
  srv.closeAllConnections();
}

function applyMcpEffect(effect: McpEffect): void {
  if (effect === 'start') startMcpListener();
  else if (effect === 'stop') stopMcpListener();
  else if (effect === 'restart') stopMcpListener(() => startMcpListener());
}

// The Stream Deck listener (streamDeckServer.ts, docs/mcp-and-stream-deck.md,
// 6.1). The keys draw the snapshot the tray holds (deckModel.ts), aged by a
// one-minute tick; a press goes through the command queue as the tray's does,
// marked done here at once so the deck and the tray agree before the page
// catches up.
let streamDeckServer: StreamDeckServer | null = null;
let streamDeckTick: ReturnType<typeof setInterval> | null = null;
// The deck's own presses, kept the full minute (deckModel.ts, deckCompletion).
const deckPressed = new Map<string, number>();

function setStreamDeckStatus(status: ListenerStatus): void {
  integrationsStatus.streamDeck = status;
  pushIntegrationsStatus();
}

function startStreamDeckListener(): void {
  if (streamDeckServer || !integrationsConfig.streamDeck.enabled) return;
  const srv = startStreamDeckServer({
    port: STREAM_DECK_PORT,
    getState: () => deckState(traySnapshot, doneHere, Date.now()),
    onCommand: (command) => {
      if (command.type === 'lg:chore:complete') {
        const now = Date.now();
        prunePresses(deckPressed, now);
        const verdict = deckCompletion(command.choreId, traySnapshot, doneHere, now, deckPressed);
        if (verdict !== 'ok') return { ok: false, reason: verdict };
        deckPressed.set(command.choreId, now);
        doneHere.set(command.choreId, now);
        queueCommand('complete', { chore_id: command.choreId }, 'streamdeck');
        refreshTray();
        return { ok: true };
      }
      const token = deckOpenToken(command.target, traySnapshot);
      if (token === false) return { ok: false, reason: 'refused' };
      openToken(token);
      return { ok: true };
    },
    log: logStartup,
  });
  streamDeckServer = srv;
  srv.wss.on('listening', () => { if (streamDeckServer === srv) setStreamDeckStatus({ running: true, error: null }); });
  srv.wss.on('error', (err) => {
    if (streamDeckServer !== srv) return;
    logStartup(`stream deck listener failed: ${(err as NodeJS.ErrnoException).code ?? err.message}`);
    stopStreamDeckListener();
    setStreamDeckStatus({ running: false, error: bindErrorCode(err) });
  });
  // The keys age with the clock while nothing else changes.
  streamDeckTick = setInterval(() => streamDeckServer?.broadcast(), 60_000);
}

function stopStreamDeckListener(): void {
  if (streamDeckTick) { clearInterval(streamDeckTick); streamDeckTick = null; }
  const srv = streamDeckServer;
  streamDeckServer = null;
  integrationsStatus.streamDeck = { running: false, error: null };
  srv?.close();
}

function applyStreamDeckEffect(effect: StreamDeckEffect): void {
  if (effect === 'start') startStreamDeckListener();
  else if (effect === 'stop') { stopStreamDeckListener(); pushIntegrationsStatus(); }
}

function applyListenerEffects(effects: { mcp: McpEffect; streamDeck: StreamDeckEffect }): void {
  applyMcpEffect(effects.mcp);
  applyStreamDeckEffect(effects.streamDeck);
}

/** Read the file and start whatever it turns on. Once, at ready. */
function startLocalIntegrations(): void {
  const { config, recovered } = loadLocalIntegrations(app.getPath('userData'));
  if (recovered) logStartup('local-integrations.json was unreadable: set aside as .corrupt, everything off');
  integrationsConfig = config;
  applyListenerEffects(listenerEffects(DEFAULT_LOCAL_INTEGRATIONS, config));
}

/** Apply one Settings change: save it, start or stop what it says, and tell the page. */
function runIntegrationsTransition(action: unknown) {
  const result = applyTransition(integrationsConfig, action, {
    now: () => new Date().toISOString(),
    newToken: () => crypto.randomBytes(32).toString('hex'),
  });
  if (!result.ok) return { ok: false, error: result.error, view: currentIntegrationsView() };
  const before = integrationsConfig;
  integrationsConfig = result.config;
  if (!saveLocalIntegrations(app.getPath('userData'), integrationsConfig)) logStartup('local-integrations.json could not be written; this session follows the change');
  applyListenerEffects(listenerEffects(before, integrationsConfig));
  // A new token reaches the file at once; a start or a port change does when the listener binds.
  updateDiscoveryFile();
  pushIntegrationsStatus();
  refreshTray();
  return { ok: true, view: currentIntegrationsView() };
}

ipcMain.handle('local-integrations:get', (event) => (isMainWindowSender(event.sender) ? currentIntegrationsView() : null));
ipcMain.handle('local-integrations:transition', (event, action: unknown) =>
  (isMainWindowSender(event.sender) ? runIntegrationsTransition(action) : { ok: false, error: 'invalid_action', view: null }));

// The MCP write journal, for Settings: what assistants changed, and undo.
ipcMain.handle('mcp-journal:get', (event) => (isMainWindowSender(event.sender) ? mcpJournal.snapshot() : null));
ipcMain.handle('mcp-journal:undo', (event, groupKey: unknown) => {
  if (!isMainWindowSender(event.sender)) return { ok: false, error: 'invalid_sender' };
  return undoMcpWrites(typeof groupKey === 'string' ? groupKey : undefined);
});

// The main window's widget snapshot (src/native/widgetBridge.ts).
ipcMain.on('widget:update-snapshot', (event, json: unknown) => {
  if (!isMainWindowSender(event.sender)) return;
  const snapshot = parseTraySnapshot(json);
  if (!snapshot) return;
  traySnapshot = snapshot;
  for (const id of settledCompletions(doneHere, snapshot)) doneHere.delete(id);
  refreshTray();
});

// The popup's calls: its state, Mark done, open a target, close.
ipcMain.handle('tray:state', (event) => (isTrayWindowSender(event.sender) ? currentTrayState() : null));
ipcMain.on('tray:complete', (event, syncId: unknown) => {
  if (isTrayWindowSender(event.sender)) completeFromTray(syncId);
});
ipcMain.on('tray:open', (event, token: unknown) => {
  if (!isTrayWindowSender(event.sender)) return;
  live(trayWindow)?.hide();
  openToken(trayOpenToken(token, traySnapshot));
});
ipcMain.on('tray:hide', (event) => {
  if (isTrayWindowSender(event.sender)) live(trayWindow)?.hide();
});


// Hooks for the tray and reminders (section 7).
function onShellLabels(): void { refreshTray(); }
function onBackgroundSettingsChanged(): void { refreshTray(); }

// The OS clock and week settings, for the page's "Automatic" time format and
// week start (systemFormats.ts). Read on each ask: the user can change them in
// system settings while the app runs, and the page asks again on wake.
async function readSystemFormats(): Promise<SystemFormats> {
  try {
    if (IS_MAC) {
      const first = systemPreferences.getUserDefault('AppleFirstWeekday', 'dictionary') as Record<string, unknown> | undefined;
      return macFormats({
        force24: systemPreferences.getUserDefault('AppleICUForce24HourTime', 'boolean') === true,
        force12: systemPreferences.getUserDefault('AppleICUForce12HourTime', 'boolean') === true,
        firstWeekday: typeof first?.gregorian === 'number' ? first.gregorian : null,
        locale: app.getSystemLocale() || null,
      });
    }
    if (process.platform === 'win32') {
      const output = await new Promise<string>((resolve) => {
        execFile('reg', ['query', 'HKCU\\Control Panel\\International'], { timeout: 3000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
      });
      return windowsFormats(output, app.getSystemLocale() || null);
    }
    return linuxFormats(process.env);
  } catch {
    return { hour24: null, weekStart: null };
  }
}

ipcMain.handle('shell:system-formats', async (event) => {
  if (!isMainWindowSender(event.sender) && !isTrayWindowSender(event.sender)) return { hour24: null, weekStart: null };
  return readSystemFormats();
});

// The "update available" notice (updateCheck.ts): direct builds only; the App
// Store updates the MAS build. Answers from a cache within the hour, and never
// throws: a failed check is simply no notice.
let updateCache: { at: number; result: AvailableUpdate | null } | null = null;
ipcMain.handle('shell:latest-release', async (event) => {
  if (!isMainWindowSender(event.sender) || process.mas) return null;
  if (updateCache && Date.now() - updateCache.at < CHECK_CACHE_MS) return updateCache.result;
  try {
    const res = await net.fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'lastGLANCE-desktop' } });
    const result = res.ok ? availableUpdate(await res.json(), app.getVersion(), process.platform) : null;
    updateCache = { at: Date.now(), result };
    return result;
  } catch {
    return null;
  }
});

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
  const firstWindow = createWindow({ startHidden: !IS_MAC && launchedHidden(process.argv) && !pendingDeepLink });

  // In-app purchases, on the Mac App Store build only (section 9; billingConfig.ts).
  // Registered once: its handlers are app-wide, and a window recreated by crash
  // recovery reads the status afresh.
  if (process.mas) registerElectronBilling(firstWindow, { ...MAS_BILLING, products: { ...MAS_BILLING.products } });

  createTray();

  // The global shortcuts saved last time.
  if (desktopSettings.popupShortcut) applyShortcut('popup', desktopSettings.popupShortcut);
  if (desktopSettings.windowShortcut) applyShortcut('window', desktopSettings.windowShortcut);
  // globalShortcut throws before ready, and will-quit can fire then (dayGLANCE
  // issue #1352); before ready nothing is registered, so there is nothing to free.
  app.on('will-quit', () => { if (app.isReady()) globalShortcut.unregisterAll(); });

  // The MCP server and Stream Deck listener, when Settings turned them on.
  startLocalIntegrations();
  // The "Set up Claude Desktop" button's handler. Direct builds only: the Mac
  // App Store package does not carry the module (electron-builder.config.cjs),
  // so it is loaded dynamically and its absence there is a no-op.
  if (!process.mas) {
    import('./mcpDesktopSetup.js')
      .then(({ registerMcpDesktopSetup }) => registerMcpDesktopSetup(
        () => (mcpGates(integrationsConfig).bound ? { port: mcpPort(integrationsConfig), token: integrationsConfig.mcp.token ?? '' } : null),
        isMainWindowSender,
      ))
      .catch((err) => logStartup(`claude desktop setup not available: ${err instanceof Error ? err.message : err}`));
  }
  app.on('will-quit', () => { stopMcpListener(); stopStreamDeckListener(); });

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
