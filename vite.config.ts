import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import { readFileSync } from 'fs'
import https from 'https'
import http from 'http'
import type { Plugin, ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'http'

const { version } = JSON.parse(readFileSync('./package.json', 'utf-8'))
const buildTime = new Date().toISOString()

// Dev-only middleware that replicates the WebDAV proxy sidecar.
// In production (Docker) the real sidecar (server.js + nginx) handles this.
function webdavProxyPlugin(): Plugin {
  return {
    name: 'webdav-proxy',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/webdav-proxy/', async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, PUT, DELETE, MKCOL, PROPFIND, OPTIONS',
            'Access-Control-Allow-Headers': 'Authorization, X-WebDAV-Auth, Content-Type, Depth',
          })
          return res.end()
        }

        const qs = req.url?.split('?')[1] ?? ''
        const target = new URLSearchParams(qs).get('url')
        if (!target) { res.writeHead(400); return res.end('Missing url') }

        try { new URL(target) } catch { res.writeHead(400); return res.end('Invalid url') }

        const headers: Record<string, string> = {}
        if (req.headers['x-webdav-auth']) headers['Authorization'] = req.headers['x-webdav-auth'] as string
        if (req.headers['depth']) headers['Depth'] = req.headers['depth'] as string
        if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'] as string

        let bodyBuf: Buffer | null = null
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          const rawBody = await new Promise<Buffer>((resolve, reject) => {
            const chunks: Buffer[] = []
            req.on('data', (chunk: Buffer) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
            req.on('end', () => resolve(Buffer.concat(chunks)))
            req.on('error', reject)
          })
          if (rawBody.length > 0) {
            bodyBuf = rawBody
            if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'] as string
          }
        }

        try {
          const parsed = new URL(target)
          const transport = parsed.protocol === 'https:' ? https : http
          const result = await new Promise<{ status: number; headers: Record<string, string>; body: string }>((resolve, reject) => {
            const reqHeaders: Record<string, string> = { ...headers, host: parsed.hostname }
            if (bodyBuf) reqHeaders['content-length'] = String(bodyBuf.length)
            const proxyReq = transport.request({
              hostname: parsed.hostname,
              port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
              path: parsed.pathname + parsed.search,
              method: req.method,
              headers: reqHeaders,
              agent: new transport.Agent({ keepAlive: false }),
            }, (proxyRes) => {
              const chunks: Buffer[] = []
              proxyRes.on('data', (c: Buffer) => chunks.push(c))
              proxyRes.on('end', () => resolve({
                status: proxyRes.statusCode ?? 502,
                headers: proxyRes.headers as Record<string, string>,
                body: Buffer.concat(chunks).toString('utf8'),
              }))
              proxyRes.on('error', reject)
            })
            proxyReq.on('error', reject)
            proxyReq.setTimeout(30000, () => proxyReq.destroy(new Error('upstream timed out')))
            if (bodyBuf) proxyReq.write(bodyBuf)
            proxyReq.end()
          })
          const ct = result.headers['content-type'] ?? 'text/plain'
          res.writeHead(result.status, { 'Content-Type': ct, 'Cache-Control': 'no-store' })
          res.end(result.body)
        } catch (err: unknown) {
          console.error('[vite-proxy] error for', req.method, target, (err as Error)?.message)
          res.writeHead(502)
          res.end('Proxy error')
        }
      })
    },
  }
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __BUILD_TIME__: JSON.stringify(buildTime),
  },
  plugins: [
    webdavProxyPlugin(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: false,
      includeAssets: [
        'favicon.ico',
        'og-image.png',
        'favicon/*.png',
        'icons/*.png',
      ],
      workbox: {
        // Include json so the i18next locale files (public/locales/**/*.json,
        // loaded at runtime over HTTP) are precached with the rest of the app
        // shell. Without this they are neither precached nor runtime-cached, so
        // on reopen the service worker can't serve them and i18next renders raw
        // keys (e.g. "app.cloudSync") until the user clears site data.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,json}'],
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
