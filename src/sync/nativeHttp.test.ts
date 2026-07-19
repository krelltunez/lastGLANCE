import { describe, it, expect, vi } from 'vitest'

// nativeHttp imports @capacitor/core at module scope; stub the pieces it touches
// so the pure ETag helpers can be tested in the jsdom/node environment.
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => 'web' },
  CapacitorHttp: { request: vi.fn() },
  registerPlugin: () => ({ request: vi.fn() }),
}))

import { normalizeEtag, etagFromHeaders } from './nativeHttp'

describe('normalizeEtag', () => {
  it('passes a plain strong etag through untouched', () => {
    expect(normalizeEtag('"6768abc"')).toBe('"6768abc"')
  })

  it('strips a weak-validator prefix', () => {
    expect(normalizeEtag('W/"6768abc"')).toBe('"6768abc"')
    expect(normalizeEtag('w/"6768abc"')).toBe('"6768abc"')
  })

  it('strips the Apache mod_deflate -gzip suffix', () => {
    expect(normalizeEtag('"6768abc-gzip"')).toBe('"6768abc"')
  })

  it('strips the mod_brotli -br suffix', () => {
    expect(normalizeEtag('"6768abc-br"')).toBe('"6768abc"')
  })

  it('handles weak + gzip-mangled etags together', () => {
    expect(normalizeEtag('W/"6768abc-gzip"')).toBe('"6768abc"')
  })

  it('handles unquoted etag values', () => {
    expect(normalizeEtag('6768abc-gzip')).toBe('6768abc')
    expect(normalizeEtag('6768abc')).toBe('6768abc')
  })

  it('leaves values merely containing gzip/br untouched', () => {
    expect(normalizeEtag('"gzip-content-v2"')).toBe('"gzip-content-v2"')
    expect(normalizeEtag('"abridged"')).toBe('"abridged"')
  })

  it('returns undefined for null/undefined/empty', () => {
    expect(normalizeEtag(null)).toBeUndefined()
    expect(normalizeEtag(undefined)).toBeUndefined()
    expect(normalizeEtag('')).toBeUndefined()
  })
})

describe('etagFromHeaders', () => {
  it('finds the header regardless of casing', () => {
    expect(etagFromHeaders({ ETag: '"a"' })).toBe('"a"')
    expect(etagFromHeaders({ Etag: '"a"' })).toBe('"a"')
    expect(etagFromHeaders({ etag: '"a"' })).toBe('"a"')
  })

  it('normalizes the value it finds', () => {
    expect(etagFromHeaders({ Etag: 'W/"a-gzip"' })).toBe('"a"')
  })

  it('returns undefined when absent', () => {
    expect(etagFromHeaders({ 'Content-Type': 'application/json' })).toBeUndefined()
    expect(etagFromHeaders(undefined)).toBeUndefined()
    expect(etagFromHeaders(null)).toBeUndefined()
  })
})
