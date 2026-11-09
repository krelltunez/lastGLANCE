// The lastGLANCE desktop shell: the main process. Design: docs/desktop-app.md.
//
// Phase 1 (section 12): the window, the app:// origin, the CSP, menus, external
// links, crash recovery and the startup log. The window, protocol and lifecycle
// code follows dayGLANCE's electron/main.ts (krelltunez/dayGLANCE@8d72008).

import { app, BrowserWindow, ipcMain, Menu, nativeTheme, protocol, screen, session, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_BASE_URL, APP_HOST, APP_SCHEME, resolveAppRequest } from './appProtocol.js';
import { buildApplicationMenuTemplate, isApplicationMenuLabels, supportsCustomApplicationMenu, type ApplicationMenuLabels } from './applicationMenu.js';
import { CONTENT_SECURITY_POLICY } from './csp.js';
import { isAllowedExternalUrl } from './externalLinks.js';
import { decideRecovery } from './rendererRecovery.js';
import { initStartupLog, logStartup } from './startupLog.js';
import { shouldQuitOnAllWindowsClosed } from './startupQuit.js';
import { DESKTOP_INFO_ARG, encodeDesktopInfo } from './desktopInfo.js';
import { loadWindowState, onScreen, saveWindowState, saveWindowTheme, windowBackgroundColor } from './windowState.js';

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
  updateApplicationMenu(labels);
});

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

function createWindow(): BrowserWindow {
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
      // The facts the preload exposes as bridge.info (desktopInfo.ts).
      additionalArguments: [
        `${DESKTOP_INFO_ARG}${encodeDesktopInfo({ version: app.getVersion(), isMAS: process.mas === true })}`,
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
    if (IS_MAC && !isQuitting) {
      // Closing hides on macOS. Hiding a fullscreen window strands its Space as
      // a black screen, so leave fullscreen first.
      event.preventDefault();
      const w = live(mainWindow);
      if (!w) return;
      if (w.isFullScreen()) {
        w.once('leave-full-screen', () => live(mainWindow)?.hide());
        w.setFullScreen(false);
      } else {
        w.hide();
      }
    }
  });

  if (saved.maximized) win.maximize();

  // Show after the first paint (no white frame), with a fallback so a renderer
  // that never paints still leaves a visible, reportable window.
  const SHOW_FALLBACK_MS = 10_000;
  let shown = false;
  const showOnce = (why: string) => {
    if (shown) return;
    shown = true;
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
  app.on('second-instance', () => showMainWindow());
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

  createWindow();

  app.on('activate', () => showMainWindow());
});

app.on('before-quit', () => { isQuitting = true; });

app.on('window-all-closed', () => {
  if (shouldQuitOnAllWindowsClosed(process.platform, didCreateMainWindow)) {
    logStartup('window-all-closed: quit');
    app.quit();
  }
});
