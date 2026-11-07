import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HEADLESS_BRIDGE_METHODS } from '@/headless/headlessMode'
import { LAUNCHER_PACKAGE } from './launcherPromo'

// The native half of the GLANCElauncher promotion: LauncherBridge.promoInfo,
// the manifest's <queries> entry, and the headless allowlist it must stay out of.

const ROOT = join(__dirname, '..', '..')
const LAUNCHER_DIR = 'android/app/src/main/java/com/lastglance/app/launcher'
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

describe('the headless allowlist', () => {
  // A headless refresh syncs and pushes the snapshot; nothing in it asks
  // whether the launcher is installed, so the method stays out of both lists.
  it('does not carry promoInfo, on either side', () => {
    expect(HEADLESS_BRIDGE_METHODS).not.toContain('promoInfo')
    const kotlin = read(`${LAUNCHER_DIR}/HeadlessBridge.kt`)
    const exposed = [...kotlin.matchAll(/@JavascriptInterface\s+fun\s+(\w+)/g)].map(m => m[1])
    expect(exposed.length).toBeGreaterThan(0)
    expect(exposed.some(name => /promo/i.test(name))).toBe(false)
    expect(kotlin).not.toMatch(/promo/i)
    // And the two lists still match, so the check above sees the whole surface.
    expect([...exposed].sort()).toEqual([...HEADLESS_BRIDGE_METHODS].sort())
  })
})

describe('LauncherBridgePlugin.promoInfo', () => {
  const plugin = read(`${LAUNCHER_DIR}/LauncherBridgePlugin.kt`)

  it('is a plugin method of the LauncherBridge plugin', () => {
    expect(plugin).toMatch(/@CapacitorPlugin\(name = "LauncherBridge"\)/)
    expect(plugin).toMatch(/@PluginMethod\s+fun promoInfo\(call: PluginCall\)/)
    expect(plugin).toContain('ret.put("sdk", Build.VERSION.SDK_INT)')
    expect(plugin).toContain('ret.put("installed", isLauncherInstalled())')
  })

  it('looks up the launcher package, and only "not found" reads as not installed', () => {
    expect(plugin).toContain(`const val LAUNCHER_PACKAGE = "${LAUNCHER_PACKAGE}"`)
    const lookup = plugin.slice(plugin.indexOf('fun isLauncherInstalled'))
    expect(lookup).toMatch(/catch \(e: PackageManager\.NameNotFoundException\) \{\s*false\s*\}/)
    expect(lookup).toMatch(/catch \(e: Exception\) \{\s*true\s*\}/)
  })
})

describe('AndroidManifest.xml', () => {
  // Without it, Android 11+ hides the package and the lookup always reads
  // "not installed", so the promotion would show to people who have it.
  it('declares the launcher in <queries>, by name only', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml')
    const queries = manifest.match(/<queries>([\s\S]*?)<\/queries>/)
    expect(queries).not.toBeNull()
    expect(queries![1]).toMatch(new RegExp(`<package\\s+android:name="${LAUNCHER_PACKAGE.replace(/\./g, '\\.')}"\\s*/>`))
    expect(manifest).not.toMatch(/<uses-permission[^>]*QUERY_ALL_PACKAGES/)
  })
})

// The web side of the call: anything but a well-formed answer from the
// Android app hides the promotion.
describe('launcherPromoInfo', () => {
  const promoInfo = vi.fn()
  let platform = 'android'

  beforeEach(() => {
    vi.resetModules()
    promoInfo.mockReset()
    platform = 'android'
    vi.doMock('@capacitor/core', () => ({ registerPlugin: () => ({ promoInfo }) }))
    vi.doMock('./platform', () => ({ isAndroid: () => platform === 'android' }))
  })
  afterEach(() => {
    vi.doUnmock('@capacitor/core')
    vi.doUnmock('./platform')
    vi.unstubAllGlobals()
  })

  const load = async () => (await import('./launcherBridge')).launcherPromoInfo

  it('passes a well-formed answer through', async () => {
    promoInfo.mockResolvedValue({ sdk: 34, installed: false })
    expect(await (await load())()).toEqual({ sdk: 34, installed: false })
  })

  it('answers null off Android without asking', async () => {
    platform = 'web'
    expect(await (await load())()).toBeNull()
    expect(promoInfo).not.toHaveBeenCalled()
  })

  it('answers null in a headless run without asking', async () => {
    vi.stubGlobal('window', {
      location: { search: '?headless=refresh&clientId=x' },
      LastGlanceHeadless: {},
    })
    expect(await (await load())()).toBeNull()
    expect(promoInfo).not.toHaveBeenCalled()
  })

  it('answers null on an error or an answer of the wrong shape', async () => {
    const fn = await load()
    promoInfo.mockRejectedValueOnce(new Error('not implemented'))
    expect(await fn()).toBeNull()
    for (const bad of [undefined, {}, { sdk: '34', installed: false }, { sdk: 34, installed: 'false' }]) {
      promoInfo.mockResolvedValueOnce(bad)
      expect(await fn()).toBeNull()
    }
  })
})
