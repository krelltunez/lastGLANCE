import https from 'https'
import http from 'http'
import { URL } from 'url'
import { lookup } from 'dns/promises'

// Disable Vercel's default body parser so we can forward raw request bodies
export const config = {
  api: {
    bodyParser: false,
  },
};

// The address checks below run on RESOLVED addresses, not hostname strings.
// A string blocklist alone is bypassable with a public DNS name whose record
// points at a private IP (and rebindable between check and connect); resolving
// first, validating every returned address, and pinning the connection to a
// validated address closes both. Literal-IP URLs still land here — dns.lookup
// parses them (including WHATWG-URL-normalized decimal/octal forms) without a
// network query. Exported for tests.

export function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable — refuse rather than guess
  }
  const [a, b] = parts;
  return (
    a === 0 ||                            // "this network"
    a === 10 ||                           // private
    a === 127 ||                          // loopback
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) ||           // link-local (cloud metadata)
    (a === 172 && b >= 16 && b <= 31) ||  // private
    (a === 192 && b === 168) ||           // private
    (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18/15
    a >= 224                              // multicast, reserved, broadcast
  );
}

export function isPrivateIPv6(address) {
  const addr = address.toLowerCase().replace(/%.*$/, ''); // strip zone id
  if (addr === '::' || addr === '::1') return true;
  const mapped = addr.match(/^::ffff:(.+)$/);
  if (mapped) {
    // IPv4-mapped — judge the embedded IPv4. dns.lookup renders the dotted
    // form; URL-normalized literals arrive as two hex groups.
    const tail = mapped[1];
    if (tail.includes('.')) return isPrivateIPv4(tail);
    const groups = tail.split(':');
    if (groups.length !== 2) return true;
    const hi = parseInt(groups[0], 16);
    const lo = parseInt(groups[1], 16);
    if (Number.isNaN(hi) || Number.isNaN(lo)) return true;
    return isPrivateIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  const first = parseInt(addr.split(':')[0] || '0', 16);
  return (
    Number.isNaN(first) ||
    first === 0 ||                          // ::/16 — reserved, v4-compatible
    (first >= 0xfe80 && first <= 0xfebf) || // link-local fe80::/10
    (first >= 0xfc00 && first <= 0xfdff) || // ULA fc00::/7
    first >= 0xff00                         // multicast ff00::/8
  );
}

// Resolve the hostname, reject if ANY returned address is private/reserved,
// and return one validated address for the connection to pin. IPv4 preferred:
// hand-picking an address forgoes Node's family fallback, and a host with a
// broken-but-advertised AAAA record must not lose the IPv4 path it uses today.
async function resolvePinnedAddress(hostname) {
  let addresses;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new Error('Could not resolve hostname');
  }
  if (!addresses || addresses.length === 0) {
    throw new Error('Could not resolve hostname');
  }
  for (const { address, family } of addresses) {
    if (family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address)) {
      throw new Error('Private/reserved addresses are not allowed');
    }
  }
  return addresses.find(a => a.family === 4) ?? addresses[0];
}

// Returns { parsed, pinned }. pinned is null when not enforcing; otherwise the
// validated { address, family } the socket must connect to.
//
// Only enforce private-address restrictions on Vercel (SSRF protection for the
// cloud-hosted deployment). Self-hosted instances run on the user's own
// network where private addresses are legitimate WebDAV targets — no
// resolution happens there at all, so their behavior is unchanged.
export async function validateProxyUrl(urlString, enforce = !!process.env.VERCEL) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are allowed');
  }

  if (!enforce) return { parsed, pinned: null };

  // URL.hostname wraps IPv6 literals in brackets; dns.lookup wants them bare.
  const pinned = await resolvePinnedAddress(parsed.hostname.replace(/^\[|\]$/g, ''));
  return { parsed, pinned };
}

function proxyRequest(method, targetUrl, headers, body, pinned = null) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'https:' ? https : http;
    const port = parsed.port || (parsed.protocol === 'https:' ? 443 : 80);

    const bodyBuf = body ? Buffer.from(body) : null;
    const reqHeaders = {
      ...headers,
      host: parsed.hostname,
    };
    if (bodyBuf) {
      reqHeaders['content-length'] = String(bodyBuf.length);
    }

    const options = {
      hostname: parsed.hostname,
      port,
      path: parsed.pathname + parsed.search,
      method,
      headers: reqHeaders,
      // Force HTTP/1.1 — avoid undici HTTP/2 negotiation issues with WebDAV
      agent: new transport.Agent({ keepAlive: false }),
    };

    // Pin the socket to the address that passed validation, via a lookup
    // override rather than by rewriting the URL: hostname above keeps driving
    // SNI, certificate identity, and the Host header (an IP in the URL would
    // break TLS against any virtual-hosted server), while a DNS answer that
    // changes between validation and connect (rebinding) never reaches the
    // socket. Node may call lookup in `all` mode (happy-eyeballs) or not —
    // serve both shapes.
    if (pinned) {
      options.lookup = (host, opts, cb) => {
        if (opts && opts.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
        else cb(null, pinned.address, pinned.family);
      };
    }

    const proxyReq = transport.request(options, (proxyRes) => {
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => {
        resolve({
          status: proxyRes.statusCode,
          headers: proxyRes.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
      proxyRes.on('error', reject);
    });

    proxyReq.on('error', reject);
    proxyReq.setTimeout(30000, () => {
      proxyReq.destroy(new Error('upstream request timed out'));
    });

    if (bodyBuf) proxyReq.write(bodyBuf);
    proxyReq.end();
  });
}

export default async function handler(req, res) {
  // Stamp every response so the client can tell a genuine proxy reply apart from
  // a static host that 404s /api/webdav-proxy/ or serves an SPA index.html
  // fallback. testConnection() in src/intents/webdav.ts checks for this marker.
  res.setHeader('X-Webdav-Proxy', 'lastglance');
  res.setHeader('Access-Control-Expose-Headers', 'ETag, X-Webdav-Proxy');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, DELETE, MKCOL, PROPFIND, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, X-WebDAV-Auth, Content-Type, Depth, If-Match, If-None-Match');
    res.setHeader('Access-Control-Max-Age', '86400');
    return res.status(204).end();
  }

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  let pinned = null;
  try {
    ({ pinned } = await validateProxyUrl(url));
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  try {
    const headers = {};

    if (req.headers['x-webdav-auth']) {
      headers['Authorization'] = req.headers['x-webdav-auth'];
    }
    if (req.headers['depth'] !== undefined) {
      headers['Depth'] = req.headers['depth'];
    }
    if (req.headers['if-match']) {
      headers['If-Match'] = req.headers['if-match']
        .split(',')
        .map(e => e.trim().replace(/^W\//, ''))
        .join(', ');
    }
    if (req.headers['if-none-match']) {
      headers['If-None-Match'] = req.headers['if-none-match'];
    }

    let body = null;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      body = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
      });
      if (body) {
        // Only set Content-Type when there is an actual body — Apache mod_dav
        // rejects PROPFIND and MKCOL with Content-Type but no body.
        headers['Content-Type'] = req.headers['content-type'] || 'application/octet-stream';
      } else {
        body = null;
      }
    }

    const response = await proxyRequest(req.method, url, headers, body, pinned);

    // Some WebDAV servers answer a GET for a missing/empty resource with a 2xx
    // whose body isn't the JSON the sync library expects — an HTML/XML error
    // page, or an empty body. Parsing those as JSON throws, and the engine
    // surfaces that as a generic sync error (the amber cloud indicator).
    // Normalise them to 404 so the engine treats it as "file not found" and
    // seeds the remote from local state instead.
    const contentType = response.headers['content-type'] || '';
    const trimmedBody = response.body.trimStart();
    if (req.method === 'GET' && response.status >= 200 && response.status < 300 &&
        (contentType.includes('text/html') || trimmedBody === '' || trimmedBody.startsWith('<'))) {
      return res.status(404).end();
    }

    res.setHeader('Content-Type', contentType || 'text/plain');
    res.setHeader('Cache-Control', 'no-store');
    if (response.headers['etag']) res.setHeader('ETag', response.headers['etag']);
    res.status(response.status).send(response.body);
  } catch (err) {
    console.error('[proxy] error for', req.method, url, err?.message ?? err);
    res.status(502).json({ error: 'Failed to proxy WebDAV request' });
  }
}
