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
//   - background settings, reminders through main, the command queue and the
//     tray popup's page (Phase 4);
//   - the page's log lines reach the log file;
//   - no uncaught page error.
//
// Usage: npm run build:electron:dir && npm run test:electron-smoke
// Linux CI runs it under xvfb-run. SMOKE_SCREENSHOT=path saves a screenshot.
import { _electron as electron } from 'playwright-core'
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
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

  // Direct Access (docs/desktop-app.md, section 5): a folder picked through the
  // native dialog (answered here with a temp folder), files by path inside it,
  // nothing outside it.
  const folder = mkdtempSync(path.join(os.tmpdir(), 'lastglance-smoke-folder-'))
  try {
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir], bookmarks: [] }) }, folder)
    const da = await page.evaluate(async () => {
      const d = window.lastGlanceDesktop.directAccess
      const picked = await d.pickFolder()
      const wrote = await d.writeFile({ rel: 'GLANCE/users/glance-users.json', text: '{"users":[]}' })
      const read = await d.readFile({ rel: 'GLANCE/users/glance-users.json' })
      const escaped = await d.writeFile({ rel: '../escaped.json', text: 'x' })
      await d.disconnect()
      const after = await d.status()
      return { picked: picked.configured && picked.reachable, wrote: wrote.ok, read: read.text, escaped: escaped.ok, after: after.configured }
    })
    check(da.picked && da.wrote && da.read === '{"users":[]}' && da.escaped === false && da.after === false
      && existsSync(path.join(folder, 'GLANCE/users/glance-users.json')),
      `direct access: pick, files by path, confined, disconnect (${JSON.stringify(da)})`)
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }

  // iCloud Drive is macOS only: elsewhere the bridge answers, and says no.
  const icloud = await page.evaluate(() => window.lastGlanceDesktop.icloud.available())
  const expectICloud = mainPlatform === 'darwin'
  check(typeof icloud?.available === 'boolean' && (expectICloud || icloud.available === false),
    `iCloud ${expectICloud ? 'answers' : 'is off'} on ${mainPlatform} (${JSON.stringify(icloud)})`)

  // Exports: the native save dialog (answered with a temp path), and the
  // pre-restore copy written silently into the app's backups folder.
  const exportDir = mkdtempSync(path.join(os.tmpdir(), 'lastglance-smoke-export-'))
  try {
    const target = path.join(exportDir, 'chosen.json')
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }) }, target)
    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    const saved = await page.evaluate(async () => {
      const f = window.lastGlanceDesktop.files
      const r = await f.saveText({ filename: 'backup.json', text: '{"saved":true}' })
      await f.stash({ filename: 'smoke-before-restore.json', text: '{"stashed":true}' })
      return r.saved
    })
    const stashed = path.join(userData, 'backups', 'smoke-before-restore.json')
    check(saved && readFileSync(target, 'utf-8') === '{"saved":true}' && readFileSync(stashed, 'utf-8') === '{"stashed":true}',
      'exports: save dialog, and the silent pre-restore copy')
    rmSync(stashed, { force: true })
  } finally {
    rmSync(exportDir, { recursive: true, force: true })
  }

  // Phase 4 (docs/desktop-app.md, sections 7, 8 and 10): background settings,
  // the reminder scheduler, the command queue, and the tray popup's page.
  const phase4 = await page.evaluate(async () => {
    const d = window.lastGlanceDesktop
    const settings = await d.shell.getBackgroundSettings()
    const future = Date.now() + 60 * 60 * 1000
    await d.notifications.schedule([{ id: 4242, title: 'Smoke chore', body: 'b', at: future, open: 'chore:smoke', actions: [], extra: { choreSyncId: 'smoke' } }])
    const pending = (await d.notifications.pending()).map((r) => r.id)
    await d.notifications.cancel([4242])
    const after = (await d.notifications.pending()).map((r) => r.id)
    const commands = await d.commands.take()
    return { settings, pending, after, commands }
  })
  check(phase4.settings?.keepRunning === true && phase4.settings?.openAtLogin === false,
    `background settings default to keep running, not at login (${JSON.stringify(phase4.settings)})`)
  check(phase4.pending.includes(4242) && !phase4.after.includes(4242), 'reminders schedule and cancel through main')
  check(Array.isArray(phase4.commands) && phase4.commands.length === 0, 'the command queue answers, empty')

  // The tray popup is the same bundle in its own window, rendered without App.
  const trayRendered = await app.evaluate(async ({ app, BrowserWindow }) => {
    const preload = `${app.getAppPath()}/dist-electron/preload.cjs`
    const w = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } })
    await w.loadURL('app://lastglance/?tray=1')
    let text = ''
    for (let i = 0; i < 50 && !text.includes('lastGLANCE'); i++) {
      await new Promise((r) => setTimeout(r, 100))
      text = await w.webContents.executeJavaScript('document.body.innerText')
    }
    w.destroy()
    return text
  })
  check(trayRendered.includes('lastGLANCE'), `the tray popup page renders (${JSON.stringify(trayRendered.slice(0, 60))})`)

  // The page's lines reach the log file in userData (shell.log).
  const logLine = `smoke-log-${Date.now()}`
  await page.evaluate((line) => window.lastGlanceDesktop.shell.log(line), logLine)
  const logFile = path.join(await app.evaluate(({ app }) => app.getPath('userData')), 'lastglance-startup.log')
  let logged = false
  for (let i = 0; i < 20 && !logged; i++) {
    logged = existsSync(logFile) && readFileSync(logFile, 'utf-8').includes(`page: ${logLine}`)
    if (!logged) await new Promise((r) => setTimeout(r, 100))
  }
  check(logged, 'the page writes to the log file')

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
