# Desktop app (Electron): design

Status: design, approved 2026-11-09. The build follows the phases in section 12.

The desktop app is the existing web bundle in an Electron shell for macOS,
Windows and Linux, after dayGLANCE's desktop app (`krelltunez/dayGLANCE`,
`electron/`), which is the reference for every pattern below. lastGLANCE needs
far less of it: no calendar, speech or Obsidian helpers, and no MCP or Stream
Deck in the first release. Both of those are on the roadmap, and section 10 sets
out the seams this design leaves for them.

Decisions taken before this document:

- **macOS ships twice, like dayGLANCE.** There is a signed and notarized
  Developer ID build on GitHub that is free, with no paywall, and a sandboxed
  Mac App Store build behind the in-app unlock. The MAS build shares the iOS
  app's purchases (Universal Purchase).
- **dayGLANCE's generic pieces are copied, not shared yet.** They are vendored
  into `electron/` with a provenance line at the top of each file. A shared
  `@glance-apps` package comes later, when lifeGLANCE needs the same pieces, so
  dayGLANCE's shipped code is not touched now.
- **The first release includes:**
  - background reminders: the app keeps running when its window is closed;
  - a menu bar (tray) popup;
  - `lastglance://` deep links.

  Auto-update is out (see section 11).

## 1. Goals and non-goals

Goals for the first desktop release:

- The whole app in a native window on all three OSes, with nothing missing
  that works on the web today.
- Sync works with no proxy and no CORS setup:
  - WebDAV and Nextcloud, including a server on the LAN;
  - GLANCEvault, with real-time push;
  - Direct Access on a real folder;
  - iCloud Drive on macOS, on both Mac builds.
- Reminders fire with the window closed, as they do on the phones: chores,
  People dates and the daily digest.
- A menu bar or tray popup shows what is due and can mark chores done.
- `lastglance://` links open a chore, a person or an action.
- Export and import of backups.
- The paywall appears on the MAS build only. Developer ID, Windows and Linux
  are free, like the GitHub sideload APK.

Non-goals for this release:

- Auto-update.
- Contacts on macOS. This could come later through `CNContactStore` behind the
  existing `Contacts` contract.
- A Microsoft Store or MSIX package.
- Windows code signing.
- iCloud on Windows.
- A headless refresh. A desktop app that stays running has no need for one.

## 2. Shell shape

**Plain Electron, no `@capacitor-community/electron`.** With that package,
`Capacitor.getPlatform()` returns `'electron'`. `Capacitor.isNativePlatform()`
then turns true while `isNativeShell()` stays false. That would send export
through `Filesystem`/`Share` and HTTP through `CapacitorHttp`, and neither
exists in Electron. A plain renderer reads `'web'` for Capacitor, and each
module that needs the shell asks for it explicitly.

**One bridge object, the headless pattern.**
- The preload exposes a single frozen object, `window.lastGlanceDesktop`,
  through `contextBridge`.
- `src/native/desktop.ts` adds `desktopBridge(): DesktopBridge | null` and
  `isDesktop()`, next to `headlessBridge()`.
- Every module that reaches native code gets a `desktopBridge()` branch, as it
  has a `headlessBridge()` branch today.

The bridge is not a single flat list of methods. It is grouped by the plugin
contracts the app already has, so the existing wrappers take the desktop
implementation unchanged:

| Group | Implements | Wrapped by |
|---|---|---|
| `info` | `{ platform: 'darwin'\|'win32'\|'linux', isMAS, version }` | `desktop.ts` |
| `http` | `ElectronProxyFetch(method, url, headers, body)`, the slot `@glance-apps/sync` already has | `nativeHttp.ts`, new `shellFetchImpl()` |
| `vaultSse` | the `VaultSse` contract (`start`, `stop`, `sseMessage`) | `native/vaultSse.ts` (`'native-bridge'` mode) |
| `secureStore` | `SecureStorePlugin` (`get`/`set`/`delete`) | `native/secureStore.ts` |
| `icloud` | `ICloudPluginType` (`available`, `readFile`, `writeFile`, `listFiles`, `deleteFile`, `makeDir`, `changed`) | `createICloudBridge(plugin)` |
| `directAccess` | the Android folder shape of `DirectAccessPluginType` | `createDirectAccessBridge(plugin, 'android')` (the folder shape) |
| `notifications` | the subset of `LocalNotifications` that `reminders.ts` uses | `native/reminders.ts` |
| `widget` | `WidgetBridgePlugin` (`updateSnapshot`, `drainPendingCompletions`, `consumeDeepLink`) | `native/widgetBridge.ts` |
| `files` | `saveTextFile` (save dialog) and `stashJsonFile` (silent, to userData) | `utils/exportFile.ts` |
| `billing` | the `api` that `createElectronRendererAdapter` expects | `billing/billing.ts` |
| `shell` | window controls, menu labels, background-mode and login-item settings | settings UI, `main.tsx` |

**The allowlist is held by a test**, as `HEADLESS_BRIDGE_METHODS` is today.
`electron/bridgeContract.test.ts` checks four things against each other:
- the TypeScript interfaces above;
- what `preload.ts` exposes;
- the `ipcMain.handle` channel names in `main.ts`;
- the existing parity anchors (`ICloudPluginType`, `DirectAccessPluginType`
  minus the iOS-only slot methods).

It is a source-text test, like `icloudIosParity.test.ts`. A method added to one
side and not the others fails CI.

## 3. Origin, storage and loading

- **The origin is `app://lastglance`, from the first build, and never changes.**
  - `protocol.registerSchemesAsPrivileged` registers `app` as standard, secure,
    fetch and CORS-enabled, before `ready`.
  - `protocol.handle` serves `dist/` through dayGLANCE's `resolveAppRequest`,
    with SPA fallback and a traversal guard.
  - Dexie and localStorage are keyed by origin, so a later move would orphan
    every chore. dayGLANCE had to migrate localStorage when it moved off
    `file://`. lastGLANCE's data is in IndexedDB, which cannot be migrated that
    way, so `file://` is never shipped.
- **Absolute asset paths work as they are.** Vite's default `base: '/'`,
  `/locales/...` and `/favicon...` all resolve on `app://lastglance/`.
- **userData is pinned to `<appData>/lastGLANCE` for both bundle IDs.**
  - The MAS sandbox still puts it inside the container, so the Developer ID
    build and the MAS build do not share local data on one Mac. That is
    expected, and sync covers it.
  - The startup log, window state, reminder schedule and Direct Access bookmark
    all live in userData.
- **No service worker.** `main.tsx` passes `shell: true` to
  `settleServiceWorker` when `isDesktop()` is true. This is the same rule as
  the native shells and the headless page: a precache served a stale bundle
  after the 2.14.0 update.
- **CSP from main.** `index.html` has no CSP today and is shared with web and
  the phones. The protocol handler therefore sets the header on `app://`
  responses.
  - The target is `connect-src 'self'`: the renderer makes no direct network
    request at all (section 4).
  - The strict policy is also a test of section 4. A fetch site that was missed
    fails loudly instead of quietly hitting CORS.
  - Dev mode skips the header for the Vite origin, as dayGLANCE does, so HMR
    works.
- **Dev loop:** `npm run dev:electron` runs Vite on a fixed port, `tsc -w` for
  main and preload, and `electronmon`, as dayGLANCE does.

## 4. Network: every request through main

**Every network request goes through main.**
- The renderer's WebDAV, GLANCEvault, intents and roster traffic all goes
  through `bridge.http`.
- `bridge.http` is main-process `net.fetch` with:
  - a 30 s timeout;
  - manual redirects, re-checked on every hop;
  - methods including PROPFIND and MKCOL;
  - normalized ETags.

This removes CORS from the picture, so a self-hosted vault or Nextcloud needs no
`app://lastglance` entry in its allowed origins.

**Wiring.**
- `nativeHttp.ts` gains the desktop branch.
- A new `shellFetchImpl()` generalizes today's `headlessFetchImpl()`. It returns
  a fetch-shaped function for the vault engines (`dbEngine.ts`,
  `people/sync/dbEngine.ts`, `multiuser/rosterVault.ts`) and for
  `vaultPro.ts`, `testVaultConnection.ts`, `setupVaultIntentsEncryption.ts` and
  `intents/dbTransport.ts`.
- `intents/webdav.ts`'s `usingProxy` must read false on desktop.

**Real-time push** also runs in main. `bridge.vaultSse` implements the existing
`VaultSse` contract over a streamed `net.fetch`, so `vaultEventStream.ts` takes
its `'native-bridge'` road. dayGLANCE instead reads SSE straight from the
renderer, which is why GLANCEvault's README tells self-hosters to allow
`app://dayglance`. lastGLANCE avoids that step.

**LAN servers.** dayGLANCE's `proxyUrlPolicy.ts` is copied as is.
- Private, loopback, CGNAT and ULA addresses are refused until the user grants
  that one host, port and scheme in a native dialog that only a button press
  can open.
- Redirect targets and link-local addresses can never be granted.

A home Nextcloud on `192.168.x.x` is a common lastGLANCE setup, so the
"Allow this server" step needs clear copy in Cloud Sync.

`syncProxySettings.ts`, the optional user-configured outbound proxy, is copied
too. It is cheap, and its absence is a support question.

## 5. Platform features

### Secure storage

`bridge.secureStore` uses Electron `safeStorage`, which wraps the macOS
Keychain, Windows DPAPI and the Linux secret service. Ciphertext is kept in
`userData/secure-store.json`.

On Linux, `getSelectedStorageBackend()` can return `basic_text`, meaning there
is no keyring. In that case the group reports unavailable and the app keeps
today's web storage, so the store never claims protection it does not give.
`isSecureStoreAvailable` becomes `isNativeShell() || headless || desktop
secure store`.

### Direct Access

Desktop implements the **Android folder contract**:
- methods: `status`, `pickFolder`, `disconnect`, `read`, `write`, and
  `paths.{list,read,write,remove,makeDir}`;
- the UI shows "Choose folder", because it branches only on `isIOS()`.

The store is dayGLANCE's `directAccessStore.ts`, Electron-free and tested under
vitest. Its rules are already lastGLANCE's own (docs/direct-access.md):
- paths are confined to the folder;
- writes replace crash-safely (temp file, fsync, rename);
- a zero-length file reads as `downloading`, never `absent`;
- a vanished folder reads as `error`.

Picking uses `dialog.showOpenDialog` with security-scoped bookmarks, which the
MAS sandbox needs; the bookmark is restored on launch. A debounced `fs.watch`
nudges a cycle, with self-write suppression. The 15 s poll stays the source of
truth.

Gate changes: `isDirectAccessAvailable` and the default `platform` argument in
`native/directAccess.ts`.

### Export and import

- `saveTextFile` opens a native save dialog.
- `stashJsonFile`, the silent pre-restore copy, writes to
  `userData/backups/` instead of popping a dialog.
- Import already works: it is `<input type=file>` plus `FileReader`.

### Notifications and reminders

Covered in section 7.

### Window chrome

- macOS uses `titleBarStyle: 'hiddenInset'`.
- `main.tsx` adds `html.desktop` and `html.desktop-mac`. The header leaves room
  for the traffic lights and gets `-webkit-app-region: drag`, with controls
  marked `no-drag`.
- Windows and Linux keep the native frame, with a localized application menu.
  The labels are pushed from the renderer, as in dayGLANCE's
  `applicationMenu.ts`.
- `html.native`, the phone safe-area trim, is not set on desktop.
- The window background comes from the persisted theme, so there is no white
  flash.
- Window size and position persist between launches.

### External links

- `setWindowOpenHandler` sends `http`, `https` and `mailto` to
  `shell.openExternal`.
- `will-navigate` is confined to the app origin.

### Hardening

- `contextIsolation` is on and `nodeIntegration` is off.
- Sensitive handlers check that `event.sender` is the main window.
- There is a single-instance lock.
- dayGLANCE's `rendererRecovery.ts` handles renderer crashes (reload, then
  recreate, then give up), and `startupLog.ts` keeps a bounded log in userData.
- DevTools are off in packaged builds, the equivalent of the
  `CAP_WEBVIEW_DEBUG` gate.

## 6. iCloud Drive on macOS

The iOS tier runs as it is: `src/sync/icloud.ts`, `useSnapshotFileSync`, the
seed-guard stamps, the tri-state preference that is on by default, and the
first-run question (docs/icloud-sync.md). Desktop only supplies the
`ICloudPluginType` object, and `isICloudAvailable` becomes "iOS, or desktop on
darwin".

**Containers.** Both are reached by plain path under
`~/Library/Mobile Documents/`:

| Container | Folder | Contents |
|---|---|---|
| `own` | `iCloud~com~lastglance/Documents/` | `lastglance-sync.json`, `lastglance-people.json` |
| `dayglance` | `iCloud~com~dayglance/Documents/` | `GLANCE/events/` for intents |

**No helper binary.** This follows dayGLANCE's `electron/icloud.ts`.
- On the Developer ID build the app is not sandboxed, and the path is ordinary
  files.
- On the MAS build, the main process carries the entitlements and reads the
  real home directory. It strips `/Library/Containers/<id>/Data` from
  `app.getPath('home')`.
- The entitlements list both containers with `CloudDocuments`:
  `iCloud.com.lastglance` and `iCloud.com.dayglance`.
- A Swift helper would not inherit the developer entitlement, which is why
  dayGLANCE's iCloud helper is vestigial.

**The read classification** (absent, downloading, error, text) is kept,
together with the tier's 2-minute download grace and `allowStale`:
- A `.name.icloud` placeholder reads as `downloading`.
- An `EDEADLK` or `ETIMEDOUT` while macOS materializes a dataless file also
  reads as `downloading`. Since macOS 14, iCloud Drive evicts files in place as
  dataless files, and a read faults them in.
- `EINTR` and `EAGAIN` are retried (dayGLANCE's `fsRetry.ts`).

**Writes.**
- Snapshots are written in place, not by temp file and rename. A rename
  replaces the inode and drops the xattrs that queue the upload. This is
  dayGLANCE's rule, and the iOS plugin's equivalent of its "event files in
  place".
- A write is a full rewrite with fsync. The cycle's seed guard and stamps
  already make a torn read retry instead of applying.

**Changes.** `fs.watch` on each `Documents/` folder, with a 1 s debounce and a
2 s self-write suppression, posts `changed`. The tier's 15 s poll remains the
backstop.

**Availability is the container folder existing.** With no native API call,
the Mac cannot create the container itself. iCloud on the Mac therefore lights
up once the iOS app has created it on that Apple ID, which is the audience for
this feature. `available()` is re-probed every cycle, as on iOS, so it appears
by itself once the folder syncs down.

**Verify on hardware before release.** Two behaviours need a real Mac:
- the dataless-file read path, a read faulting in an evicted file;
- the MAS sandbox reaching the `dayglance` container.

Neither can be tested in CI.

## 7. Background mode, reminders and the tray

### Staying alive

- **macOS:** closing the window hides it, as Mac apps do. It leaves fullscreen
  first, or the Space is left black.
- **Windows and Linux:** with "Keep running in the background" on, closing
  hides the window to the tray. The first time, a notification says
  lastGLANCE is still running. With the setting off, closing quits.
- The setting defaults to on, because reminders depend on it.
- "Open at login" is off by default:
  - macOS and Windows use `app.setLoginItemSettings`, which is SMAppService on
    MAS;
  - Linux uses an XDG autostart `.desktop` file.

### The renderer keeps working while hidden

- The main window is created with `backgroundThrottling: false`, so the 15 s
  sync polls and the reminder diff keep their cadence.
- Many hooks kick work on `visibilitychange`, and a hidden window never sends
  it. Main therefore forwards two events: `powerMonitor` resume and unlock, and
  window show. `bridge.shell.onWake` triggers the same kicks as foregrounding.

### Reminders

`reminders.ts` keeps its logic:
- the desired-versus-pending diff;
- `reminderIdFor`;
- the People dates and digest;
- the "Mark done" and "Send to dayGLANCE" actions.

`bridge.notifications` implements the calls it makes: `checkPermissions`,
`requestPermissions`, `schedule`, `cancel`, `getPending`, `registerActionTypes`
and the action listener.

Main owns the schedule:
- It persists it to `userData/reminders.json` and arms a timer for the next one
  due.
- It re-arms on resume and on clock or timezone change.
- On launch or resume, a reminder missed within 12 hours fires once. Older ones
  are dropped.

Firing:
- A reminder fires an Electron `Notification`.
- A click opens the target through the deep-link token path (section 8).
- On macOS the "Mark done" action is a real notification button, which Electron
  supports there. Windows and Linux get click-to-open only.
- An action becomes a queued command (section 10), so it is applied through the
  app's own handlers.

The web path's `fireBrowserNotification` awaits `navigator.serviceWorker.ready`,
which never resolves when no worker is registered. Desktop does not take that
path. Section 7 replaces it.

Windows needs `app.setAppUserModelId('com.lastglance.app')`, or toasts are
attributed to "electron.app.lastGLANCE". The People reminder fields in Settings
(`SettingsPanel.tsx`) are shown on desktop.

### The tray popup is a widget

**The data path.**
- The popup never opens Dexie and never runs a sync engine. Two writers on one
  database and two sync loops are exactly what the widget design avoids on the
  phones.
- The main window pushes the existing widget snapshot (`native/snapshot.ts`,
  `buildSnapshot`) through `bridge.widget.updateSnapshot`, and main caches it.
- The popup loads `app://lastglance/?tray=1`. It renders a compact due list
  from that snapshot, and "Mark done" queues a completion.
- The main renderer drains the queue (`usePendingCompletions`, which already
  handles widget completions on the phones). Main nudges it with an event, so
  this happens at once rather than on the next foreground.

**Per OS.**
- **macOS:** a menu bar template icon. Left click toggles a frameless popup
  anchored under the icon, which hides on blur. Right click opens a menu: Open
  lastGLANCE, Quit.
- **Windows:** the same popup, anchored to the tray icon's bounds.
- **Linux:** a native menu only, with Open, the top due chores each with "Mark
  done", and Quit. AppIndicator does not deliver clicks reliably on many
  desktops, so a popup window cannot be anchored there.

## 8. Deep links

- The app registers `lastglance://` with `app.setAsDefaultProtocolClient`, in
  `CFBundleURLTypes` on macOS, and through the `.desktop` `MimeType` on Linux.
  - The deb package registers the scheme.
  - An AppImage registers it only if the user integrates it (with appimaged or
    Gear Lever). This limitation is documented.
- URLs arrive through:
  - `open-url` on macOS;
  - `second-instance` argv on Windows and Linux;
  - `process.argv` on a cold start.
- Main maps a URL to the same internal token iOS uses: `chore:<id>`,
  `filter:soon`, `action:search`, `action:add`, `chores`, `pinned`,
  `person:<id>`, `log:<id>`, `people`, `action:add-person`. It stashes the
  token, shows the window and fires an event.
- The renderer consumes the token through `bridge.widget.consumeDeepLink()`.
  That is the pull model `pendingDeepLink.ts` already uses.
- The mapping is a pure function in `electron/deepLink.ts`. A test holds it
  equal to the `case` list in `ios/App/App/AppDelegate.swift`.

## 9. Billing

- `billing.ts` gains a desktop branch:
  `isGatedChannel = ... || (isDesktop() && info.isMAS)`.
  - `info.isMAS` is `process.mas`.
  - `@glance-apps/billing/electron-main` independently checks for the MAS
    receipt, and every other build answers `{ active: true }`. That makes two
    independent "free" signals for Developer ID, Windows and Linux.
- The adapter is `createElectronRendererAdapter({ api: bridge.billing })`.
- Main calls `registerElectronBilling(win, { rcApiKey, entitlementId,
  products: PRODUCT_IDS })`. This is StoreKit through `inAppPurchase`, verified
  by RevenueCat with the iOS app's App Store key, because the products are the
  same under Universal Purchase.
- On MAS, `STORE_NAME` is "App Store" and `MANAGE_SUBSCRIPTION_URL` is Apple's.
- `GATE_DISMISSIBLE` follows iOS (no close control): a Mac app has no
  sanctioned way to dismiss itself either. The reviewer code works unchanged.
- The billing parity table test gains the desktop rows:
  - MAS gated;
  - Developer ID, Windows and Linux ungated;
  - web unchanged.

## 10. Commands from outside the window, and the road to MCP and Stream Deck

Four surfaces act on data the renderer owns:
- the tray popup;
- notification actions;
- MCP, later;
- Stream Deck, later.

They all use one pattern, after the launcher queue (`src/intents/launcherQueue.ts`
and CLAUDE.md's "Launcher writes are applied, then pushed"):

**Writes go through a durable queue in main.**
- Main appends a command to `userData/commands.json`. Each command has a
  `clientId`, an action from `handleIntent`'s vocabulary (`complete`, `create`,
  `log_interaction`, `open`) and a payload.
- Main nudges the renderer.
- The renderer takes the command, applies it with `handleIntent` and the app's
  own ledger, and only then acknowledges it by `clientId`.
- A crash between take and acknowledge replays the command, and the ledger
  makes the replay harmless.
- The main renderer has its vault engines registered, so dirty tracking marks
  the write and it is pushed. That was the 2.13.0 lesson.

**Reads come from the snapshot, or from a request bridge.**
- The tray, and later Stream Deck tiles, read the cached widget snapshot.
- MCP, later, adds dayGLANCE's `mcpRendererBridge` pattern: a
  `request(method, params, timeoutMs)` that never rejects or hangs, and answers
  `renderer_unavailable` instead of an empty result.

In this release the queue carries the tray's and the notifications' "Mark done".
It is written generically so that MCP and Stream Deck do not need a second write
path.

**Ports, reserved now, so the two apps can run side by side.** dayGLANCE uses
7892 for its Stream Deck WebSocket and 7893 for MCP.

| Port | Use | Source |
|---|---|---|
| 7900 | MCP | the lastGLANCE example in `@glance-apps/mcp-host`'s README |
| 7901 | Stream Deck WebSocket | |

**Later MCP work.** For reference only, not this release:
- `@glance-apps/mcp-host` for the listener.
- A `lastglance-mcp` read model in the style of `packages/dayglance-mcp`.
- The `@glance-apps/mcp-bridge` stdio bridge in `extraResources`, and dayGLANCE's
  Claude Desktop config writer, including its MSIX path handling.
- On MAS, all of it compiled out (Guideline 2.5.2), with a verify script, as
  dayGLANCE does.

## 11. Build, packaging and release

### Layout

| Path | Contents |
|---|---|
| `electron/` | `main.ts`, `preload.ts` and the modules, each with its vitest test beside it; the entitlements plists |
| `electron-builder.config.cjs` | packaging config |
| `tsconfig.electron.json` | main, ESM |
| `tsconfig.electron.preload.json` | preload, CommonJS |
| `vite.config.electron.ts` | the base config without `VitePWA`; defines `__DESKTOP__` and `__MAS_BUILD__` |

The `tsconfig` files use `removeComments`. vitest's include gains `electron/`.

### Scripts

`dev:electron`, `build:electron`, `build:electron:release` and
`build:electron:mas`, as in dayGLANCE.

### Electron version

The same major as dayGLANCE (43), so the two apps share fixes and
`@glance-apps/billing`'s tested Electron surface.

### Identity

| Build | appId | Why |
|---|---|---|
| Developer ID, Windows, Linux | `com.lastglance.app` | matches Android |
| MAS | `com.lastglance` | matches iOS, for Universal Purchase |

`productName` is lastGLANCE. The MAS build switches the appId through an
environment variable, as dayGLANCE does.

### Targets

dayGLANCE's set, including the electron-builder lessons it learned:

| OS | Targets | Notes |
|---|---|---|
| macOS (Developer ID) | `dmg` and `zip`, x64 and arm64 | |
| macOS (MAS) | `pkg`, universal | |
| Windows | `nsis` | unsigned, so SmartScreen warns on first run; see risks |
| Linux | `AppImage` and `deb`, x64 and arm64 | explicit arch list; arch in every filename; `category`, `icon` and `maintainer` set |

- `mac.electronLanguages` is limited to the shipped locales.
- `.map` files are excluded.

### Signing and notarization

- dayGLANCE's `codesign-ad-hoc.cjs` (afterPack) and `notarize.cjs` (afterSign),
  driven by `CSC_LINK`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
  `APPLE_TEAM_ID`.
- Hardened Runtime is on for Developer ID.
- The MAS build is sandboxed and needs these entitlements:
  - network client;
  - user-selected read-write files;
  - app-scope bookmarks;
  - both iCloud containers.

  There is no network server entitlement until MCP or Stream Deck arrive, and
  no in-app payments entitlement (App Review rejects it).
- The MAS provisioning profile is git-ignored or supplied by
  `MAC_PROVISIONING_PROFILE`.

### Versioning

- `package.json` stays the single source.
- `CFBundleShortVersionString` comes from it.
- MAS `buildVersion` is `YYYYMMDD.HHMM`, so App Store uploads always increase.

### CI

- `ci.yml` gains:
  - the `electron/` typecheck;
  - its tests;
  - a Playwright `_electron` smoke test on Linux under xvfb. It launches the
    unpacked app, checks that the page is on `app://lastglance`, that Dexie
    opens, and that no service worker is registered.
- A new `release-desktop.yml` mirrors dayGLANCE's:
  - a matrix of `macos-15` (pinned), `windows-latest` and `ubuntu-latest`;
  - it runs on a version tag or manual dispatch;
  - it produces a draft GitHub release with the DMG, zip, exe, AppImage and deb.
- MAS is built locally and uploaded with Transporter, as dayGLANCE's
  `RELEASING.md` describes.
- Release notes follow CLAUDE.md: no em dashes.

### No auto-update in this release

Direct builds update by downloading the new release. They show a small "update
available" notice, like dayGLANCE's `versionCheck.js`: the renderer asks the
GitHub releases API every 6 h and links to the release. The notice is never
shown on MAS, where the App Store updates the app.

## 12. Build phases

Each phase lands as its own PR, with tests.

1. **Scaffold.**
   - Main, preload and the `app://lastglance` protocol.
   - The window, menus, external links, CSP, startup log and crash recovery.
   - `desktop.ts`, the SW retire step and the `html.desktop` chrome.
   - The dev loop, the unsigned builds for all three OSes, and the CI smoke
     test.

   This is where we see the app run on each OS.
2. **Network and sync.**
   - `bridge.http`, `shellFetchImpl()` at every fetch site, the URL policy and
     its grant dialog, and `vaultSse` in main.
   - The secure store.
   - Direct Access.
   - Export and stash.
3. **iCloud Drive on macOS.**
   - The `icloud` group for both containers, the watcher and the gate.
   - The first-run question on a Mac with an empty install.
4. **Background mode.**
   - Background mode and the open-at-login setting.
   - The reminder scheduler and notification actions.
   - The command queue.
   - The tray popup and Linux menu.
   - Deep links.
5. **Release.**
   - Signing and notarization, and `release-desktop.yml`.
   - The MAS build: entitlements, provisioning, billing, and the parity and
     gate tests.
   - The "update available" notice on direct builds.
   - `RELEASING`-style steps for desktop in the docs, and the README sections.

Later: MCP, then Stream Deck, on the seams in section 10.

## 13. Prerequisites outside the repo

These steps need your accounts, and the MAS phase needs them done:

- **Apple Developer, App ID `com.lastglance`:**
  - enable macOS for the App ID;
  - confirm both iCloud containers are assigned to it (iOS already uses them);
  - create a Mac App Store provisioning profile that includes them.
- **App Store Connect:** add the macOS platform to the existing lastGLANCE app
  record. Universal Purchase then carries `lastglance_pro_annual` and
  `lastglance_pro_lifetime` to the Mac.
- **RevenueCat:** confirm that the iOS App Store app config covers Mac
  receipts. It does for dayGLANCE.
- **GitHub secrets on this repo** for the Developer ID build: `CSC_LINK`,
  `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and
  `APPLE_TEAM_ID`. They can be the same team's values that dayGLANCE uses.

## 14. Risks and decisions

**Risks.**
- **iCloud on macOS 14 and later.** The dataless-file read path and the MAS
  sandbox reaching `iCloud~com~dayglance` both need a real Mac (section 6). If
  the dataless path misbehaves, the fallback is a small native addon that
  reads `NSURLUbiquitousItemDownloadingStatusKey`. It would load in the main
  process, so it holds the entitlements.
- **Unsigned Windows installer.** SmartScreen shows "Windows protected your PC"
  until the installer gains reputation. dayGLANCE ships this way today. A
  signing certificate, such as Azure Trusted Signing, is a separate later
  decision.
- **Linux tray and notifications vary by desktop environment.** The tray is
  menu-only on Linux for this reason. Notification actions are macOS-only.
- **Two Mac builds keep separate local data.** That is expected, and the README
  will say so.

**Decided in review (2026-11-09).**
1. Direct builds show the "update available" notice (section 11). MAS does not.
2. "Keep running in the background" defaults to on for Windows and Linux, so
   reminders work out of the box (section 7).
3. Ports 7900 (MCP) and 7901 (Stream Deck) are reserved (section 10).
