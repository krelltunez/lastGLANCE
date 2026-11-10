import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import './index.css'
import i18n from './i18n'
import { hydrateSecureConfig, installSecureConfigShim } from './sync/secureConfigShim'
import { headlessBridge, headlessRequest } from './headless/headlessMode'
import { initHardwareBackButton } from './native/backButton'
import { lockViewportScaleOnIPhone } from './utils/viewportZoom'
import { settleServiceWorker } from './native/serviceWorker'
import { recordFirstSeen } from './native/launcherPromo'
import { desktopBridge } from './native/desktop'
import { syncDesktopMenuLabels } from './native/desktopMenu'
import { installDesktopWake } from './native/desktopWake'
import { listenForEscape } from './hooks/useEscapeKey'

// crypto.randomUUID() is only available in secure contexts (HTTPS / localhost).
// This polyfill covers HTTP access over a LAN IP (e.g. self-hosted Docker).
if (typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    return [b.slice(0, 4), b.slice(4, 6), b.slice(6, 8), b.slice(8, 10), b.slice(10, 16)]
      .map(s => Array.from(s).map(x => x.toString(16).padStart(2, '0')).join('')).join('-') as `${string}-${string}-${string}-${string}-${string}`
  }
}

// Mark native (Capacitor) builds so platform-only styling — e.g. the landscape
// status-bar padding trim — applies there but not in the desktop browser/PWA,
// where the window is "landscape" whenever it's wider than tall.
if (Capacitor.isNativePlatform()) {
  document.documentElement.classList.add('native')
}

// The Electron desktop shell (docs/desktop-app.md) is not a Capacitor shell, so
// `native` stays off there; `desktop` and `desktop-<platform>` carry its window
// chrome instead (the macOS traffic-light inset and drag region, index.css).
const desktop = desktopBridge()
// The tray popup (src/tray/) is the same bundle in its own window.
const trayMode = desktop !== null && new URLSearchParams(window.location.search).get('tray') === '1'
if (desktop) {
  document.documentElement.classList.add('desktop', `desktop-${desktop.info.platform}`)
  if (!trayMode) {
    syncDesktopMenuLabels(i18n, desktop)
    installDesktopWake(desktop)
  }
  // Escape leaves fullscreen even before any modal has opened (useEscapeKey).
  listenForEscape()
}

// The PWA service worker is for the browser only; a native shell, including
// Android's headless refresh WebView and the desktop app, removes one an
// earlier build left and,
// when such a worker served this page, reloads from the installed bundle
// instead of booting (see native/serviceWorker.ts).
const booting = settleServiceWorker({
  shell: Capacitor.isNativePlatform() || headlessBridge() !== null || desktop !== null,
  container: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
  caches: 'caches' in window ? window.caches : undefined,
  session: (() => { try { return window.sessionStorage } catch { return undefined } })(),
  reload: () => window.location.reload(),
  onLoad: fn => window.addEventListener('load', fn),
})

// Cap the viewport scale on iPhone before anything can take focus, so WebKit
// cannot zoom the page in on a sub-16px field it can never zoom back out of
// (see utils/viewportZoom.ts). No-op on every other platform.
lockViewportScaleOnIPhone()

// Apply theme before React renders to avoid flash. 'system' (or nothing
// stored yet) follows the OS.
const saved = localStorage.getItem('theme')
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
if (saved === 'dark' || (saved !== 'light' && prefersDark)) {
  document.documentElement.classList.add('dark')
}

// App is loaded only in its own mode: a headless refresh (src/headless/, run by
// the Android shell with no Activity) does not evaluate App's modules, and the
// app does not carry the headless root.
const render = async () => {
  const { default: App } = await import('./App')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Suspense fallback={null}>
        <App />
      </Suspense>
    </StrictMode>,
  )
}

// The tray popup renders only the due list main sends it: no database, no
// sync engine, no App (docs/desktop-app.md, section 7).
const renderTray = async () => {
  if (!desktop) return
  const { TrayPopup } = await import('./tray/TrayPopup')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Suspense fallback={null}>
        <TrayPopup tray={desktop.tray} />
      </Suspense>
    </StrictMode>,
  )
}

// One sync cycle and a launcher push, then the shell tears the WebView down.
// The credentials it needs come through the same shim, hydrated first.
const runHeadless = async (clientId: string) => {
  const bridge = headlessBridge()
  if (!bridge) return
  const { runHeadlessRefresh } = await import('./headless/headlessRefresh')
  await runHeadlessRefresh(clientId, { bridge })
}

// On Android, route credential-bearing config through the Keystore-backed
// SecureStore (issue #210). Hydration must finish before the first render:
// IntentsContext and the sync engines read these keys synchronously during
// mount. Both calls are no-ops off Android, and a hydration failure still
// renders — the app degrades to "sync not configured", never a blank screen.
const boot = () => {
  if (trayMode) { void renderTray(); return }
  installSecureConfigShim()
  const headless = headlessRequest(window.location.search)
  if (headless) {
    hydrateSecureConfig()
      .catch(() => {})
      .then(() => runHeadless(headless.clientId))
  } else {
    // The @capacitor/app plugin (added for the paywall dismiss control) swallows
    // the hardware back button unless a JS listener owns it — this restores the
    // stock behavior app-wide. No-op off Android.
    initHardwareBackButton()
    // The first day the app ran on this device, for the GLANCElauncher card in
    // Settings (shown three days in). Android only, and never in a headless
    // run, which takes the branch above (recordFirstSeen checks for one too).
    recordFirstSeen({ platform: Capacitor.getPlatform(), now: Date.now() })
    hydrateSecureConfig()
      .catch(() => {})
      .then(render)
  }
}
booting.then(go => { if (go) boot() }, boot)
