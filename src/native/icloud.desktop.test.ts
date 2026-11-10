import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

function desktop(platform: 'darwin' | 'win32' | 'linux') {
  const icloud = {
    available: vi.fn(async () => ({ available: true })),
    readFile: vi.fn(async () => ({ kind: 'text', text: '{"v":1}' })),
    writeFile: vi.fn(async () => ({ ok: true })),
    listFiles: vi.fn(async () => ({ names: ['a.json'] })),
    deleteFile: vi.fn(async () => ({ ok: true })),
    makeDir: vi.fn(async () => ({ ok: true })),
    onChanged: vi.fn(() => () => {}),
  }
  vi.stubGlobal('window', {
    lastGlanceDesktop: {
      info: { platform, version: '3.0.1', isMAS: false, secureStorage: true },
      shell: { setMenuLabels: () => {}, setTheme: () => {}, exitFullscreen: () => {} },
      icloud,
    },
  })
  return icloud
}

describe('iCloud on the desktop', () => {
  it('is on for the macOS app, through the same bridge the iOS shell gets', async () => {
    const icloud = desktop('darwin')
    const { icloudBridge, isICloudAvailable } = await import('./icloud')
    expect(isICloudAvailable()).toBe(true)
    const bridge = icloudBridge()!
    expect(await bridge.available()).toBe(true)
    expect(await bridge.read('lastglance-sync.json')).toEqual({ kind: 'text', text: '{"v":1}' })
    await bridge.write('GLANCE/events/e.json', '{}', { container: 'dayglance' })
    expect(icloud.writeFile).toHaveBeenCalledWith({ path: 'GLANCE/events/e.json', text: '{}', container: 'dayglance', atomic: false })
    const stop = bridge.onChanged(() => {})
    await Promise.resolve()
    expect(icloud.onChanged).toHaveBeenCalledOnce()
    stop()
  })

  it.each(['win32', 'linux'] as const)('is off on %s', async (platform) => {
    desktop(platform)
    const { icloudBridge, isICloudAvailable } = await import('./icloud')
    expect(isICloudAvailable()).toBe(false)
    expect(icloudBridge()).toBeNull()
  })
})
