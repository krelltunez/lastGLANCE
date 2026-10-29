// The Android shell permits cleartext http app-wide (network_security_config)
// so self-hosted sync works against a plain-http NAS on the user's own network.
// That also lets an http URL to the public internet through, where the WebDAV
// password crosses the wire unencrypted. The settings form warns rather than
// blocks: a host that does not look local may still be a LAN name (split DNS,
// a custom router domain), so the user decides.

/** True when `raw` is an http:// URL whose host does not look like a home-network address. */
export function isCleartextRemoteUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  return !isLocalHost(url.hostname)
}

const LOCAL_SUFFIXES = ['.localhost', '.local', '.lan', '.home', '.home.arpa', '.internal']

function isLocalHost(rawHost: string): boolean {
  let host = rawHost.toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) return isLocalIPv6(host.slice(1, -1))
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (!host) return false
  if (host === 'localhost') return true
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
    return (
      a === 127 || // loopback
      a === 10 || // 10.0.0.0/8
      (a === 192 && b === 168) || // 192.168.0.0/16
      (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
      (a === 169 && b === 254) || // link-local
      (a === 100 && b >= 64 && b <= 127) // 100.64.0.0/10 (Tailscale, CGNAT)
    )
  }
  // A single-label name ("diskstation", a Tailscale MagicDNS short name) only
  // resolves on a local resolver.
  return !host.includes('.')
}

function isLocalIPv6(host: string): boolean {
  return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host)
}
