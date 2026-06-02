import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'
import { readFileSync } from 'fs'
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

        let body: string | undefined
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          body = await new Promise<string>((resolve, reject) => {
            let data = ''
            req.on('data', (chunk: Buffer) => { data += chunk })
            req.on('end', () => resolve(data))
            req.on('error', reject)
          })
        }

        try {
          const upstream = await fetch(target, {
            method: req.method,
            headers,
            body: body || undefined,
          })
          const text = await upstream.text()
          const ct = upstream.headers.get('content-type') ?? 'text/plain'
          res.writeHead(upstream.status, { 'Content-Type': ct, 'Cache-Control': 'no-store' })
          res.end(text)
        } catch {
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
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
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
