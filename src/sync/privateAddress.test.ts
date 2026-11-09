import { describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import { blockedMessage, checkPrivateAddress, consentLabels, grantPrivateAddress, providerServerUrl } from './privateAddress'

const t = ((key: string, opts?: Record<string, unknown>) => (opts?.origin ? `${key}(${opts.origin})` : key)) as unknown as TFunction

describe('checkPrivateAddress', () => {
  it('is null off the desktop, for no URL, and when the URL goes through', async () => {
    expect(await checkPrivateAddress('https://192.168.1.2/', null)).toBeNull()
    const http = { inspect: vi.fn(async () => ({ blocked: false as const })), grant: vi.fn() }
    expect(await checkPrivateAddress('', http)).toBeNull()
    expect(await checkPrivateAddress('https://dav.example.com/', http)).toBeNull()
  })

  it('reports a blocked origin and whether a grant can unlock it', async () => {
    const http = {
      inspect: vi.fn(async (url: string) => url.includes('192.168')
        ? { blocked: true as const, canGrant: true as const, origin: 'https://192.168.1.2', addresses: ['192.168.1.2'] }
        : { blocked: true as const, canGrant: false as const, origin: 'http://169.254.169.254', reason: 'Link-local' }),
      grant: vi.fn(),
    }
    expect(await checkPrivateAddress('https://192.168.1.2/dav', http)).toEqual({ origin: 'https://192.168.1.2', canGrant: true })
    expect(await checkPrivateAddress('http://169.254.169.254/', http)).toEqual({ origin: 'http://169.254.169.254', canGrant: false })
  })

  it('never blocks the test when the check itself fails', async () => {
    const http = { inspect: vi.fn(async () => { throw new Error('ipc down') }), grant: vi.fn() }
    expect(await checkPrivateAddress('https://192.168.1.2/', http)).toBeNull()
  })
})

describe('providerServerUrl', () => {
  const fields = [{ key: 'webdavUrl', type: 'url' }, { key: 'username', type: 'text' }]
  it('reads the url field, trimmed', () => {
    expect(providerServerUrl(fields, { webdavUrl: '  https://nas.lan/dav ', username: 'me' })).toBe('https://nas.lan/dav')
  })
  it('is null for a provider without one (Koofr) or an empty field', () => {
    expect(providerServerUrl([{ key: 'username', type: 'text' }], { username: 'me' })).toBeNull()
    expect(providerServerUrl(fields, { webdavUrl: ' ' })).toBeNull()
  })
})

describe('the permission flow', () => {
  it('words a grantable and a refused address differently', () => {
    expect(blockedMessage(t, { origin: 'https://nas.lan', canGrant: true })).toBe('sync.privateAddress.needsPermission(https://nas.lan)')
    expect(blockedMessage(t, { origin: 'http://169.254.169.254', canGrant: false })).toBe('sync.privateAddress.refused(http://169.254.169.254)')
  })

  it('sends every dialog label, with the warning for this computer chosen by kind', () => {
    expect(Object.keys(consentLabels(t, 'vault')).sort()).toEqual(
      ['allow', 'cancel', 'question', 'resolvesTo', 'scope', 'title', 'warning', 'warningLoopback'],
    )
    expect(consentLabels(t, 'vault').warningLoopback).toBe('sync.privateAddress.consentWarningLoopbackVault')
    expect(consentLabels(t, 'server').warningLoopback).toBe('sync.privateAddress.consentWarningLoopbackServer')
  })

  it('returns null once granted, else the reason to show', async () => {
    const granted = { inspect: vi.fn(), grant: vi.fn(async () => ({ ok: true })) }
    expect(await grantPrivateAddress(t, 'https://nas.lan/', 'server', granted)).toBeNull()
    const declined = { inspect: vi.fn(), grant: vi.fn(async () => ({ ok: false, reason: 'Permission declined.' })) }
    expect(await grantPrivateAddress(t, 'https://nas.lan/', 'server', declined)).toBe('Permission declined.')
    expect(await grantPrivateAddress(t, 'https://nas.lan/', 'server', null)).toBe('sync.privateAddress.grantFailed')
  })
})
