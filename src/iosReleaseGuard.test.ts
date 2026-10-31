import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * A Release build (every Archive) must not ship a Safari-inspectable WebView.
 * capacitor.config.ts writes ios.webContentsDebuggingEnabled only when `cap
 * sync` runs with CAP_WEBVIEW_DEBUG=1, and the synced value persists, so the
 * App target runs scripts/ios-release-config-guard.sh on every build and it
 * fails Release from that state. CI cannot run Xcode, so this runs the real
 * script under sh (with a stand-in for the one macOS tool it calls, plutil)
 * and holds the project to running it.
 */
const root = resolve(__dirname, '..')
const GUARD = join(root, 'scripts/ios-release-config-guard.sh')
const PHASE = 'Refuse an inspectable Release build'

let dir: string

// Answers exactly the two plutil invocations the guard makes, for JSON input:
// `-convert json -o - <file>` (exit 1 on unparseable input) and
// `-extract <keypath> raw -o - <file>` (exit 1 on a missing key; booleans
// print as true/false, as the real raw format does).
const PLUTIL_STANDIN = `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const file = args[args.length - 1]
let data
try { data = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { process.exit(1) }
if (args[0] === '-convert') process.exit(0)
if (args[0] === '-extract') {
  let v = data
  for (const k of args[1].split('.')) {
    if (v === null || typeof v !== 'object' || !(k in v)) process.exit(1)
    v = v[k]
  }
  process.stdout.write(String(v) + '\\n')
  process.exit(0)
}
process.exit(2)
`

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ios-guard-'))
  writeFileSync(join(dir, 'plutil'), PLUTIL_STANDIN)
  chmodSync(join(dir, 'plutil'), 0o755)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function guard(configuration: string | undefined, config: string | null | object) {
  let path = join(dir, 'missing.json')
  if (config !== null) {
    path = join(dir, 'capacitor.config.json')
    writeFileSync(path, typeof config === 'string' ? config : JSON.stringify(config, null, 2))
  }
  const env: Record<string, string> = { PATH: `${dir}:${process.env.PATH}` }
  if (configuration) env.CONFIGURATION = configuration
  const r = spawnSync('sh', [GUARD, path], { env, encoding: 'utf8' })
  return { status: r.status, stderr: r.stderr }
}

const synced = (ios: object) => ({ appId: 'com.lastglance.app', android: { webContentsDebuggingEnabled: false }, ios })

describe('ios-release-config-guard.sh', () => {
  it('fails a Release build synced with CAP_WEBVIEW_DEBUG=1', () => {
    const r = guard('Release', synced({ webContentsDebuggingEnabled: true }))
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/^error: .*Safari-inspectable/)
  })

  it('passes an ordinary Release build (key absent) and an explicit false', () => {
    expect(guard('Release', synced({})).status).toBe(0)
    expect(guard('Release', synced({ webContentsDebuggingEnabled: false })).status).toBe(0)
  })

  it('leaves Debug builds alone, so Xcode Run stays inspectable', () => {
    expect(guard('Debug', synced({ webContentsDebuggingEnabled: true })).status).toBe(0)
    expect(guard(undefined, synced({ webContentsDebuggingEnabled: true })).status).toBe(0)
  })

  it('looks only at the iOS key, not Android\'s', () => {
    const config = { appId: 'x', android: { webContentsDebuggingEnabled: true }, ios: {} }
    expect(guard('Release', config).status).toBe(0)
  })

  it('fails closed when the Release config cannot be read or parsed', () => {
    expect(guard('Release', null).status).toBe(1)
    expect(guard('Release', '{ not json').status).toBe(1)
  })
})

describe('the App target runs the guard', () => {
  const pbx = readFileSync(join(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8')

  it('as a build phase of the App target, on every build', () => {
    const target = pbx.slice(pbx.indexOf('/* App */ = {\n\t\t\tisa = PBXNativeTarget;'))
    const phases = target.slice(target.indexOf('buildPhases = ('), target.indexOf(');', target.indexOf('buildPhases = (')))
    expect(phases).toContain(`/* ${PHASE} */`)
    const id = phases.match(new RegExp(`([0-9A-F]{24}) /\\* ${PHASE} \\*/`))![1]
    const phase = pbx.slice(pbx.indexOf(`\t\t${id} /* ${PHASE} */ = {`), pbx.indexOf('\t\t};', pbx.indexOf(`\t\t${id} /* ${PHASE} */ = {`)))
    expect(phase).toContain('isa = PBXShellScriptBuildPhase;')
    // Not skipped by dependency analysis, and not limited to install builds.
    expect(phase).toContain('alwaysOutOfDate = 1;')
    expect(phase).toContain('runOnlyForDeploymentPostprocessing = 0;')
    expect(phase).toContain('scripts/ios-release-config-guard.sh')
    expect(phase).toContain('/App/capacitor.config.json')
    // Declared inputs, so it can read both under Xcode's script sandboxing.
    expect(phase).toMatch(/inputPaths = \(\s*"\$\(SRCROOT\)\/\.\.\/\.\.\/scripts\/ios-release-config-guard\.sh",\s*"\$\(SRCROOT\)\/App\/capacitor\.config\.json",/)
  })
})

describe('capacitor.config.ts', () => {
  afterEach(() => vi.unstubAllEnvs())

  // Imported by a computed path: the config sits outside the app's TS project.
  async function loadConfig(flag?: string) {
    if (flag !== undefined) vi.stubEnv('CAP_WEBVIEW_DEBUG', flag)
    else vi.stubEnv('CAP_WEBVIEW_DEBUG', '')
    vi.resetModules()
    const path = join(root, 'capacitor.config.ts')
    return (await import(/* @vite-ignore */ path)).default
  }

  it('writes the iOS key only for CAP_WEBVIEW_DEBUG=1, and never as false', async () => {
    expect((await loadConfig('1')).ios.webContentsDebuggingEnabled).toBe(true)
    // Absent rather than false: false would also switch off Debug-build inspection.
    expect('webContentsDebuggingEnabled' in (await loadConfig()).ios).toBe(false)
    expect('webContentsDebuggingEnabled' in (await loadConfig('0')).ios).toBe(false)
  })
})
