#!/usr/bin/env node
// Desktop smoke test (docs/desktop-app.md, section 11, CI): launch the PACKAGED
// app (electron-builder --dir output, so app.isPackaged is true and the real
// app:// protocol serves the bundle) and check what no unit test can see:
//
//   - the page is on app://lastglance, the origin the data lives under;
//   - the preload exposed the bridge, with this build's version;
//   - Dexie opened the `lastglance` database there;
//   - no service worker registered;
//   - the CSP blocks a direct network request from the renderer;
//   - the desktop chrome classes are set and `native` is not;
//   - requests go through the main process: a server on a private address is
//     refused until granted, then reached, and the grant can be revoked;
//   - no uncaught page error.
//
// Usage: npm run build:electron:dir && npm run test:electron-smoke
// Linux CI runs it under xvfb-run. SMOKE_SCREENSHOT=path saves a screenshot.
import { _electron as electron } from 'playwright-core'
import { readFileSync, existsSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8'))

const executable = {
  linux: 'dist-app/linux-unpacked/lastglance',
  win32: 'dist-app/win-unpacked/lastGLANCE.exe',
  darwin: `dist-app/mac${process.arch === 'arm64' ? '-arm64' : ''}/lastGLANCE.app/Contents/MacOS/lastGLANCE`,
}[process.platform]
const executablePath = path.join(root, executable)
if (!existsSync(executablePath)) {
  console.error(`No packaged app at ${executable}. Run: npm run build:electron:dir`)
  process.exit(2)
}

const failures = []
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

// --no-sandbox: CI runners (and root in containers) cannot use Chromium's
// setuid sandbox. The shipped app keeps it.
const app = await electron.launch({ executablePath, args: ['--no-sandbox'], timeout: 60_000 })
const pageErrors = []
try {
  const page = await app.firstWindow()
  page.on('pageerror', (err) => pageErrors.push(String(err)))
  await page.waitForLoadState('load')
  // The app is up once React has rendered its header.
  await page.waitForSelector('header', { timeout: 30_000 })

  const url = page.url()
  check(url.startsWith('app://lastglance/'), `page is on app://lastglance (${url})`)

  const info = await page.evaluate(() => window.lastGlanceDesktop?.info ?? null)
  check(info?.version === version, `bridge reports version ${version} (${info?.version})`)
  const mainPlatform = await app.evaluate(() => process.platform)
  check(info?.platform === mainPlatform, `bridge reports the platform (${info?.platform})`)
  check(info?.isMAS === false, 'bridge reports a non-MAS build')

  // Secure storage: a round trip where the OS protects secrets; elsewhere
  // (Linux without a keyring, as on CI) the app reports it and keeps web storage.
  if (info?.secureStorage === true) {
    const stored = await page.evaluate(async () => {
      const s = window.lastGlanceDesktop.secureStore
      await s.set({ key: 'smoke-test', value: 'v' })
      const { value } = await s.get({ key: 'smoke-test' })
      await s.delete({ key: 'smoke-test' })
      return value
    })
    check(stored === 'v', 'secure storage round-trips')
  } else {
    check(info?.secureStorage === false, `secure storage reported unavailable here (${info?.secureStorage})`)
  }

  const dbs = await page.evaluate(async () => (await indexedDB.databases()).map((d) => d.name))
  check(dbs.includes('lastglance'), `Dexie opened the lastglance database (${dbs.join(', ')})`)

  // app:// is not registered with allowServiceWorkers, so Chromium refuses the
  // API outright there (InvalidStateError): no worker can ever control the page.
  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported'
    if (navigator.serviceWorker.controller) return 'controlled'
    try {
      return `${(await navigator.serviceWorker.getRegistrations()).length} registrations`
    } catch (e) {
      return e instanceof DOMException && e.name === 'InvalidStateError' ? 'refused on this origin' : `error: ${e}`
    }
  })
  check(['unsupported', '0 registrations', 'refused on this origin'].includes(sw), `no service worker (${sw})`)

  const csp = await page.evaluate(() => new Promise((resolve) => {
    const onViolation = (e) => resolve(e.violatedDirective)
    document.addEventListener('securitypolicyviolation', onViolation, { once: true })
    fetch('https://example.com/').catch(() => {})
    setTimeout(() => resolve(null), 5000)
  }))
  check(csp === 'connect-src', `CSP blocks a direct network request (${csp})`)

  const classes = await page.evaluate(() => document.documentElement.className)
  check(/\bdesktop\b/.test(classes) && classes.includes(`desktop-${info?.platform}`), `desktop chrome classes set (${classes})`)
  check(!/\bnative\b/.test(classes), 'not marked as a Capacitor native shell')

  // The network path (docs/desktop-app.md, section 4), against a local server:
  // 127.0.0.1 is a private address, so it needs a grant. The native dialog is
  // answered "Allow" by replacing showMessageBox in the main process.
  const hits = []
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`)
    if (req.url.startsWith('/events')) {
      // A heartbeat, then one event, then held open like a real vault.
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': heartbeat\n\n')
      res.write('data: {"seq":42}\n\n')
      return
    }
    res.writeHead(207)
    res.end('<multistatus/>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const target = `http://127.0.0.1:${server.address().port}/dav/`
  try {
    const call = (fn, ...args) => page.evaluate(([f, a]) => window.lastGlanceDesktop.http[f](...a), [fn, args])
    const refused = await call('request', 'PROPFIND', target, { Depth: '0' }, null)
    check(refused?.error === 'Private/reserved address' && hits.length === 0, `a private address is refused before any request (${JSON.stringify(refused)})`)
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    const granted = await call('grant', target, {})
    const reached = await call('request', 'PROPFIND', target, { Depth: '0' }, null)
    check(granted?.ok === true && reached?.status === 207 && hits.length === 1, `once granted, the request reaches the server (${reached?.status}, ${hits.join(', ')})`)
    const origin = new URL(target).origin
    await call('revoke', origin)
    const again = await call('request', 'GET', target, {}, null)
    check(again?.error === 'Private/reserved address' && hits.length === 1, 'a revoked grant refuses again')

    // GLANCEvault's real-time push, read by the main process and relayed.
    await call('grant', target, {})
    const sse = await page.evaluate(([vaultUrl]) => new Promise((resolve) => {
      const seen = []
      const stop = window.lastGlanceDesktop.vaultSse.onMessage((m) => {
        seen.push(m)
        if (m.type === 'frame') { stop(); void window.lastGlanceDesktop.vaultSse.stop(); resolve(seen) }
      })
      void window.lastGlanceDesktop.vaultSse.start({ vaultUrl, vaultToken: 'smoke', accountId: 'a1' })
      setTimeout(() => { stop(); resolve(seen) }, 8000)
    }), [new URL(target).origin])
    const types = sse.map((m) => m.type).join(',')
    check(types === 'open,frame' && sse[1].block === 'data: {"seq":42}' && hits.includes('GET /events?accountId=a1'),
      `vault live updates reach the page (${types})`)
  } finally {
    server.closeAllConnections?.()
    server.close()
  }

  if (process.env.SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.SMOKE_SCREENSHOT })
  check(pageErrors.length === 0, `no uncaught page errors${pageErrors.length ? `: ${pageErrors.join(' | ')}` : ''}`)
} finally {
  await app.close()
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\ndesktop smoke test passed')
