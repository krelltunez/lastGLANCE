import { afterEach, describe, expect, it, vi } from 'vitest'
import { desktopBridge, isDesktop, isDesktopMac } from './desktop'

const shell = { setMenuLabels: () => {}, setTheme: () => {} }

function stubWindow(lastGlanceDesktop: unknown) {
  vi.stubGlobal('window', { lastGlanceDesktop })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('desktopBridge', () => {
  it('is null with no window (vitest, SSR) and on web or a phone', () => {
    expect(desktopBridge()).toBeNull()
    stubWindow(undefined)
    expect(desktopBridge()).toBeNull()
    expect(isDesktop()).toBe(false)
  })

  it('answers the shell’s bridge', () => {
    stubWindow({ info: { platform: 'linux', version: '3.0.1', isMAS: false }, shell })
    expect(isDesktop()).toBe(true)
    expect(desktopBridge()?.info.version).toBe('3.0.1')
    expect(isDesktopMac()).toBe(false)
  })

  it('knows a Mac', () => {
    stubWindow({ info: { platform: 'darwin', version: '3.0.1', isMAS: true }, shell })
    expect(isDesktopMac()).toBe(true)
  })

  it('refuses a malformed object or an unknown platform', () => {
    stubWindow({ info: { platform: 'darwin' } })
    expect(desktopBridge()).toBeNull()
    stubWindow({ info: { platform: 'android', version: '1', isMAS: false }, shell })
    expect(desktopBridge()).toBeNull()
  })
})
