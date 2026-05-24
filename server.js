import http from 'http'
import { URL } from 'url'
import handler from './api/webdav-proxy.js'

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost')
  req.query = Object.fromEntries(u.searchParams)

  // Adapt Node.js ServerResponse to the Vercel-style res.status().send() interface
  res.status = (code) => {
    res.statusCode = code
    return {
      json:  (obj)  => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)) },
      send:  (body) => res.end(body),
      end:   ()     => res.end(),
    }
  }

  handler(req, res).catch((err) => {
    console.error('[proxy] unhandled error:', err)
    if (!res.headersSent) { res.statusCode = 502; res.end('Bad Gateway') }
  })
})

server.listen(3001, '127.0.0.1', () => console.log('[proxy] listening on 127.0.0.1:3001'))
