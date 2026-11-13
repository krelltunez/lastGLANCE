// The lastGLANCE desktop bridge: the one object the renderer sees, as
// `window.lastGlanceDesktop` (docs/desktop-app.md, section 2). Its groups
// mirror the app's existing plugin contracts; the renderer's types and the
// method allowlist are src/native/desktop.ts, and bridgeContract.test.ts holds
// this file, that one and main.ts's IPC handlers to the same list.
//
// Sandboxed: this script may import only `electron`, so it decodes the info
// switch itself rather than importing electron/desktopInfo.ts. Keep each group
// a flat object literal of `name: (...) => ...` entries; the contract test
// reads them from the source.

import { contextBridge, ipcRenderer } from 'electron';

const DESKTOP_INFO_ARG = '--lastglance-desktop-info=';

function readInfo(): { version: string; isMAS: boolean; secureStorage: boolean } {
  const arg = process.argv.find((a) => a.startsWith(DESKTOP_INFO_ARG));
  try {
    const parsed = JSON.parse(decodeURIComponent((arg ?? '').slice(DESKTOP_INFO_ARG.length)));
    if (typeof parsed?.version === 'string' && typeof parsed?.isMAS === 'boolean' && typeof parsed?.secureStorage === 'boolean') {
      return { version: parsed.version, isMAS: parsed.isMAS, secureStorage: parsed.secureStorage };
    }
  } catch { /* absent or malformed: fall through */ }
  return { version: '', isMAS: false, secureStorage: false };
}

const info = readInfo();

// A main-to-renderer event as a listener the renderer can remove: returns the
// unsubscribe function. The IPC event object never reaches the page.
function subscribe(channel: string, listener: (payload: unknown) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
}

contextBridge.exposeInMainWorld('lastGlanceDesktop', {
  info: {
    platform: process.platform,
    version: info.version,
    isMAS: info.isMAS,
    secureStorage: info.secureStorage,
  },
  shell: {
    setMenuLabels: (labels: Record<string, string>) => ipcRenderer.send('shell:set-menu-labels', labels),
    setTheme: (dark: boolean) => ipcRenderer.send('shell:set-theme', dark),
    exitFullscreen: () => ipcRenderer.send('shell:exit-fullscreen'),
    log: (message: string) => ipcRenderer.send('shell:log', message),
    getBackgroundSettings: () => ipcRenderer.invoke('shell:get-background-settings'),
    setBackgroundSettings: (patch: { keepRunning?: boolean; openAtLogin?: boolean }) => ipcRenderer.invoke('shell:set-background-settings', patch),
    onWake: (listener: (payload: unknown) => void) => subscribe('shell:wake', listener),
    systemFormats: () => ipcRenderer.invoke('shell:system-formats'),
    latestRelease: () => ipcRenderer.invoke('shell:latest-release'),
    getShortcuts: () => ipcRenderer.invoke('shell:get-shortcuts'),
    setShortcut: (kind: string, accelerator: string) => ipcRenderer.invoke('shell:set-shortcut', kind, accelerator),
  },
  http: {
    request: (method: string, url: string, headers: Record<string, string>, body: string | null) => ipcRenderer.invoke('http:request', method, url, headers, body),
    inspect: (url: string) => ipcRenderer.invoke('http:inspect', url),
    grant: (url: string, labels: Record<string, string>) => ipcRenderer.invoke('http:grant', url, labels),
    grants: () => ipcRenderer.invoke('http:grants'),
    revoke: (origin: string) => ipcRenderer.invoke('http:revoke', origin),
  },
  vaultSse: {
    start: (options: { vaultUrl: string; vaultToken: string; accountId: string }) => ipcRenderer.invoke('vault-sse:start', options),
    stop: () => ipcRenderer.invoke('vault-sse:stop'),
    onMessage: (listener: (message: unknown) => void) => subscribe('vault-sse:message', listener),
  },
  secureStore: {
    get: (options: { key: string }) => ipcRenderer.invoke('secure-store:get', options.key),
    set: (options: { key: string; value: string }) => ipcRenderer.invoke('secure-store:set', options.key, options.value),
    delete: (options: { key: string }) => ipcRenderer.invoke('secure-store:delete', options.key),
  },
  directAccess: {
    status: () => ipcRenderer.invoke('direct-access:status'),
    pickFolder: () => ipcRenderer.invoke('direct-access:pick-folder'),
    disconnect: () => ipcRenderer.invoke('direct-access:disconnect'),
    read: () => ipcRenderer.invoke('direct-access:read'),
    write: (options: { text: string }) => ipcRenderer.invoke('direct-access:write', options),
    deleteFile: () => ipcRenderer.invoke('direct-access:delete'),
    listFiles: (options: { rel: string }) => ipcRenderer.invoke('direct-access:list-files', options),
    readFile: (options: { rel: string }) => ipcRenderer.invoke('direct-access:read-file', options),
    writeFile: (options: { rel: string; text: string }) => ipcRenderer.invoke('direct-access:write-file', options),
    deleteFileAt: (options: { rel: string }) => ipcRenderer.invoke('direct-access:delete-file', options),
    makeDir: (options: { rel: string }) => ipcRenderer.invoke('direct-access:make-dir', options),
    onChanged: (listener: (payload: unknown) => void) => subscribe('direct-access:changed', listener),
  },
  files: {
    saveText: (options: { filename: string; text: string }) => ipcRenderer.invoke('files:save-text', options),
    stash: (options: { filename: string; text: string }) => ipcRenderer.invoke('files:stash', options),
  },
  notifications: {
    checkPermissions: () => ipcRenderer.invoke('notifications:permission'),
    schedule: (list: unknown[]) => ipcRenderer.invoke('notifications:schedule', list),
    cancel: (ids: number[]) => ipcRenderer.invoke('notifications:cancel', ids),
    pending: () => ipcRenderer.invoke('notifications:pending'),
  },
  widget: {
    updateSnapshot: (json: string) => ipcRenderer.send('widget:update-snapshot', json),
    consumeDeepLink: () => ipcRenderer.invoke('widget:consume-deep-link'),
    onDeepLink: (listener: (payload: unknown) => void) => subscribe('widget:deep-link', listener),
  },
  tray: {
    state: () => ipcRenderer.invoke('tray:state'),
    complete: (syncId: string) => ipcRenderer.send('tray:complete', syncId),
    open: (token: string | null) => ipcRenderer.send('tray:open', token),
    hide: () => ipcRenderer.send('tray:hide'),
    onState: (listener: (payload: unknown) => void) => subscribe('tray:state', listener),
    onShown: (listener: (payload: unknown) => void) => subscribe('tray:shown', listener),
  },
  // In-app purchases on the Mac App Store build: the ElectronBillingApi of
  // @glance-apps/billing, whose main half registers these channels.
  billing: {
    subscriptionStatus: () => ipcRenderer.invoke('subscription:status'),
    subscriptionPurchase: (productId: string) => ipcRenderer.invoke('subscription:purchase', productId),
    subscriptionRestore: () => ipcRenderer.invoke('subscription:restore'),
    subscriptionPrices: () => ipcRenderer.invoke('subscription:prices'),
    onSubscriptionEvent: (listener: (payload: unknown) => void) => subscribe('subscription:event', listener),
    onSubscriptionPricesReady: (listener: (payload: unknown) => void) => subscribe('subscription:prices-ready', listener),
  },
  commands: {
    take: () => ipcRenderer.invoke('commands:take'),
    ack: (ids: string[]) => ipcRenderer.invoke('commands:ack', ids),
    onQueued: (listener: (payload: unknown) => void) => subscribe('commands:queued', listener),
  },
  localIntegrations: {
    get: () => ipcRenderer.invoke('local-integrations:get'),
    transition: (action: Record<string, unknown>) => ipcRenderer.invoke('local-integrations:transition', action),
    onStatus: (listener: (payload: unknown) => void) => subscribe('local-integrations:status', listener),
  },
  mcp: {
    onRequest: (listener: (payload: unknown) => void) => subscribe('mcp:request', listener),
    respond: (response: Record<string, unknown>) => ipcRenderer.send('mcp:response', response),
  },
  mcpJournal: {
    get: () => ipcRenderer.invoke('mcp-journal:get'),
    undo: (groupKey: string | null) => ipcRenderer.invoke('mcp-journal:undo', groupKey),
    onChanged: (listener: (payload: unknown) => void) => subscribe('mcp-journal:changed', listener),
  },
  icloud: {
    available: () => ipcRenderer.invoke('icloud:available'),
    readFile: (options: { path: string; container?: string; allowStale?: boolean }) => ipcRenderer.invoke('icloud:read-file', options),
    writeFile: (options: { path: string; text: string; container?: string; atomic?: boolean }) => ipcRenderer.invoke('icloud:write-file', options),
    listFiles: (options: { path: string; container?: string }) => ipcRenderer.invoke('icloud:list-files', options),
    deleteFile: (options: { path: string; container?: string }) => ipcRenderer.invoke('icloud:delete-file', options),
    makeDir: (options: { path: string; container?: string }) => ipcRenderer.invoke('icloud:make-dir', options),
    onChanged: (listener: (payload: unknown) => void) => subscribe('icloud:changed', listener),
  },
});
