import { afterEach, describe, expect, it, vi } from 'vitest'

// Which builds are gated, and how the gate reads, per channel
// (docs/desktop-app.md, section 9). Each row loads billing.ts afresh under its
// platform, build channel and desktop bridge.

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
  vi.doUnmock('@capacitor/core')
})

async function load(platform: string, channel: string | undefined, desktop: { platform: string; isMAS: boolean } | null) {
  vi.doMock('@capacitor/core', () => ({
    Capacitor: { getPlatform: () => platform, isNativePlatform: () => platform !== 'web', isPluginAvailable: () => false },
    registerPlugin: () => new Proxy({}, { get: () => async () => ({}) }),
  }))
  if (channel) vi.stubEnv('VITE_BUILD_CHANNEL', channel)
  vi.stubGlobal('window', desktop
    ? { lastGlanceDesktop: { info: { platform: desktop.platform, version: '3.1.0', isMAS: desktop.isMAS, secureStorage: true }, shell: { setTheme: () => {} }, billing: {} } }
    : {})
  return import('./billing')
}

describe('billing channels', () => {
  it.each([
    // [row, platform, channel, desktop, gated, store, dismissible]
    ['web and PWA', 'web', undefined, null, false, 'Google Play', true],
    ['Android, GitHub sideload', 'android', 'github', null, false, 'Google Play', true],
    ['Android, Play', 'android', 'play', null, true, 'Google Play', true],
    ['iOS', 'ios', undefined, null, true, 'App Store', false],
    ['desktop, Mac App Store', 'web', undefined, { platform: 'darwin', isMAS: true }, true, 'App Store', false],
    ['desktop, Mac Developer ID', 'web', undefined, { platform: 'darwin', isMAS: false }, false, 'Google Play', true],
    ['desktop, Windows', 'web', undefined, { platform: 'win32', isMAS: false }, false, 'Google Play', true],
    ['desktop, Linux', 'web', undefined, { platform: 'linux', isMAS: false }, false, 'Google Play', true],
  ] as const)('%s', async (_row, platform, channel, desktop, gated, store, dismissible) => {
    const b = await load(platform, channel, desktop)
    expect(b.BILLING_GATED).toBe(gated)
    if (gated) {
      expect(b.STORE_NAME).toBe(store)
      expect(b.GATE_DISMISSIBLE).toBe(dismissible)
    }
  })

  it('the Mac App Store app manages its subscription in the App Store', async () => {
    const b = await load('web', undefined, { platform: 'darwin', isMAS: true })
    expect(b.MANAGE_SUBSCRIPTION_URL).toContain('apps.apple.com')
  })
})
