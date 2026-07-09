import https from 'https'
import http from 'http'
import { URL } from 'url'

// Disable Vercel's default body parser so we can forward raw request bodies
export const config = {
  api: {
    bodyParser: false,
  },
};

function validateProxyUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http and https URLs are allowed');
  }

  const hostname = parsed.hostname.toLowerCase();

  // Only enforce private IP restrictions on Vercel (SSRF protection for the
  // cloud-hosted deployment). Self-hosted instances run on the user's own
  // network where private addresses are legitimate WebDAV targets.
  if (process.env.VERCEL) {
    if (hostname === 'localhost' || hostname === '0.0.0.0') {
      throw new Error('Private/reserved addresses are not allowed');
    }

    const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
      if (
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        a === 127 ||
        (a === 169 && b === 254) ||
        a === 0 ||
        (a === 100 && b >= 64 && b <= 127)
      ) {
        throw new Error('Private/reserved addresses are not allowed');
      }
    }

    if (
      hostname === '::1' ||
      hostname === '::' ||
      /^::ffff:/i.test(hostname) ||
      /^fe80:/i.test(hostname) ||
      /^fc/i.test(hostname) ||
      /^fd/i.test(hostname)
    ) {
      throw new Error('Private/reserved addresses are not allowed');
    }
  }

  return parsed;
}

function proxyRequest(method, targetUrl, headers, body) {
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

  try {
    validateProxyUrl(url);
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

    const response = await proxyRequest(req.method, url, headers, body);

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
