import { describe, it, expect, afterEach, vi } from 'vitest'
import { isWebCryptoAvailable } from './secureContext'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isWebCryptoAvailable', () => {
  it('is true when crypto.subtle.importKey exists (secure context)', () => {
    vi.stubGlobal('crypto', { subtle: { importKey: () => {} } })
    expect(isWebCryptoAvailable()).toBe(true)
  })

  it('is false when crypto.subtle is undefined (insecure context — HTTP on a LAN IP)', () => {
    vi.stubGlobal('crypto', { getRandomValues: () => {} })
    expect(isWebCryptoAvailable()).toBe(false)
  })

  it('is false when crypto itself is undefined', () => {
    vi.stubGlobal('crypto', undefined)
    expect(isWebCryptoAvailable()).toBe(false)
  })

  it('is false when subtle exists but importKey is missing', () => {
    vi.stubGlobal('crypto', { subtle: {} })
    expect(isWebCryptoAvailable()).toBe(false)
  })
})
