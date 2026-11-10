import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const log = vi.fn()

function desktop(platform: 'darwin' | 'win32' | 'linux') {
  log.mockClear()
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
      shell: { setMenuLabels: () => {}, setTheme: () => {}, exitFullscreen: () => {}, log },
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
    expect(bridge.absentMayBePending).toBe(true)   // a folder iCloud has not filled in yet looks empty
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

describe('the desktop log', () => {
  it('sends a line to the shell on the desktop, and is a no-op elsewhere', async () => {
    desktop('darwin')
    const { desktopLog } = await import('./desktop')
    desktopLog('[icloud] merged')
    expect(log).toHaveBeenCalledWith('[icloud] merged')
    vi.unstubAllGlobals()
    vi.stubGlobal('window', {})
    expect(() => desktopLog('x')).not.toThrow()
    expect(log).toHaveBeenCalledTimes(1)
  })
})
