import { describe, it, expect } from 'vitest'
import { isCleartextRemoteUrl } from './insecureUrl'

describe('isCleartextRemoteUrl', () => {
  it('never flags https or unparseable input', () => {
    expect(isCleartextRemoteUrl('https://dav.example.com')).toBe(false)
    expect(isCleartextRemoteUrl('')).toBe(false)
    expect(isCleartextRemoteUrl('not a url')).toBe(false)
  })

  it.each([
    'http://192.168.68.116:5005/lastglance-sync/data/',
    'http://10.0.0.5',
    'http://172.20.1.1',
    'http://127.0.0.1:8080',
    'http://100.101.102.103',
    'http://169.254.1.1',
    'http://localhost:5005',
    'http://diskstation:5005',
    'http://nas.local',
    'http://nas.lan',
    'http://nas.home',
    'http://server.home.arpa',
    'http://nas.internal',
    'http://[::1]:5005',
    'http://[fd12:3456::1]',
    'http://[fe80::1]',
  ])('does not flag a home-network host: %s', (url) => {
    expect(isCleartextRemoteUrl(url)).toBe(false)
  })

  it.each([
    'http://dav.example.com',
    'http://myname.synology.me:5005',
    'HTTP://Cloud.Example.com/remote.php/dav',
    'http://8.8.8.8',
    'http://172.32.0.1',
    'http://100.128.0.1',
    'http://[2001:db8::1]',
  ])('flags a public http host: %s', (url) => {
    expect(isCleartextRemoteUrl(url)).toBe(true)
  })
})
