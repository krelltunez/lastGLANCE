import { describe, it, expect, vi } from 'vitest'

// Mock DNS so hostname-based cases are deterministic and offline. Literal IPs
// bypass the mock's table and use the same literal-parse behavior as the real
// getaddrinfo (no network query for literals either way).
const dnsTable = {
  localhost: [{ address: '127.0.0.1', family: 4 }],
  'nas.rebind.example': [{ address: '10.0.0.5', family: 4 }],
  'metadata.rebind.example': [{ address: '93.184.216.34', family: 4 }, { address: '169.254.169.254', family: 4 }],
  'dav.example.com': [{ address: '93.184.216.34', family: 4 }],
  'dual.example.com': [{ address: '2606:4700::1111', family: 6 }, { address: '93.184.216.34', family: 4 }],
}
vi.mock('dns/promises', async importOriginal => {
  const real = await importOriginal()
  return {
    ...real,
    lookup: async (hostname, opts) => {
      if (dnsTable[hostname]) return dnsTable[hostname]
      return real.lookup(hostname, opts)
    },
  }
})

const { validateProxyUrl, isPrivateIPv4, isPrivateIPv6 } = await import('./webdav-proxy.js')

const PRIVATE_ERR = 'Private/reserved addresses are not allowed'

describe('isPrivateIPv4', () => {
  it.each([
    '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255',
    '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '198.18.0.1', '198.19.255.255', '224.0.0.1', '255.255.255.255',
  ])('blocks %s', ip => {
    expect(isPrivateIPv4(ip)).toBe(true)
  })

  it.each([
    '8.8.8.8', '93.184.216.34', '100.63.255.255', '100.128.0.1', '172.15.0.1',
    '172.32.0.1', '192.167.0.1', '192.169.0.1', '198.17.0.1', '198.20.0.1', '223.255.255.255',
  ])('allows %s', ip => {
    expect(isPrivateIPv4(ip)).toBe(false)
  })

  it('refuses unparseable input rather than allowing it', () => {
    expect(isPrivateIPv4('not-an-ip')).toBe(true)
    expect(isPrivateIPv4('1.2.3')).toBe(true)
    expect(isPrivateIPv4('1.2.3.999')).toBe(true)
  })
})

describe('isPrivateIPv6', () => {
  it.each([
    '::', '::1', 'fe80::1', 'febf::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    // IPv4-mapped, both renderings: dns.lookup's dotted form and the
    // WHATWG-URL-normalized hex form of ::ffff:127.0.0.1
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:192.168.1.5', '::ffff:c0a8:105',
    'fe80::1%eth0', // zone id stripped, still link-local
  ])('blocks %s', ip => {
    expect(isPrivateIPv6(ip)).toBe(true)
  })

  it.each([
    '2606:4700::1111', '2001:4860:4860::8888',
    '::ffff:8.8.8.8', '::ffff:808:808', // mapped PUBLIC v4 is fine
  ])('allows %s', ip => {
    expect(isPrivateIPv6(ip)).toBe(false)
  })
})

describe('validateProxyUrl', () => {
  it('rejects non-http(s) schemes regardless of enforcement', async () => {
    await expect(validateProxyUrl('ftp://example.com/x', false)).rejects.toThrow('Only http and https')
    await expect(validateProxyUrl('file:///etc/passwd', true)).rejects.toThrow('Only http and https')
  })

  it('rejects malformed URLs', async () => {
    await expect(validateProxyUrl('not a url', false)).rejects.toThrow('Invalid URL')
  })

  it('skips resolution entirely when not enforcing (self-hosted)', async () => {
    const { pinned } = await validateProxyUrl('http://192.168.1.5/dav/', false)
    expect(pinned).toBeNull()
  })

  it.each([
    'http://10.0.0.1/dav/',
    'http://192.168.1.5/dav/',
    'http://172.16.0.1/dav/',
    'http://127.0.0.1/dav/',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost/dav/',
    'http://[::1]/dav/',
    'http://[fe80::1]/dav/',
    'http://[::ffff:127.0.0.1]/dav/', // URL normalizes to [::ffff:7f00:1]
  ])('blocks %s when enforcing', async url => {
    await expect(validateProxyUrl(url, true)).rejects.toThrow(PRIVATE_ERR)
  })

  it.each([
    // WHATWG URL canonicalizes exotic IPv4 encodings before validation ever
    // runs; these all become 127.0.0.1 and must stay blocked.
    'http://2130706433/',
    'http://0177.0.0.1/',
    'http://0x7f000001/',
  ])('blocks encoded-loopback %s when enforcing', async url => {
    await expect(validateProxyUrl(url, true)).rejects.toThrow(PRIVATE_ERR)
  })

  it('blocks a public hostname whose DNS answer is a private address', async () => {
    await expect(validateProxyUrl('https://nas.rebind.example/dav/', true)).rejects.toThrow(PRIVATE_ERR)
  })

  it('blocks when ANY resolved address is private, even alongside public ones', async () => {
    await expect(validateProxyUrl('https://metadata.rebind.example/dav/', true)).rejects.toThrow(PRIVATE_ERR)
  })

  it('pins a public hostname to its validated address', async () => {
    const { pinned } = await validateProxyUrl('https://dav.example.com/dav/', true)
    expect(pinned).toEqual({ address: '93.184.216.34', family: 4 })
  })

  it('prefers IPv4 when a dual-stack host lists AAAA first', async () => {
    const { pinned } = await validateProxyUrl('https://dual.example.com/dav/', true)
    expect(pinned).toEqual({ address: '93.184.216.34', family: 4 })
  })

  it('pins public IP literals without a DNS query', async () => {
    const v4 = await validateProxyUrl('https://93.184.216.34/dav/', true)
    expect(v4.pinned).toEqual({ address: '93.184.216.34', family: 4 })
    const v6 = await validateProxyUrl('https://[2606:4700::1111]/dav/', true)
    expect(v6.pinned.family).toBe(6)
  })
})
