import { StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { Capacitor } from '@capacitor/core'
import './index.css'
import './i18n'
import App from './App'

// crypto.randomUUID() is only available in secure contexts (HTTPS / localhost).
// This polyfill covers HTTP access over a LAN IP (e.g. self-hosted Docker).
if (typeof crypto.randomUUID !== 'function') {
  crypto.randomUUID = () => {
    const b = crypto.getRandomValues(new Uint8Array(16))
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    return [b.slice(0, 4), b.slice(4, 6), b.slice(6, 8), b.slice(8, 10), b.slice(10, 16)]
      .map(s => Array.from(s).map(x => x.toString(16).padStart(2, '0')).join('')).join('-') as `${string}-${string}-${string}-${string}-${string}`
  }
}

// Mark native (Capacitor) builds so platform-only styling — e.g. the landscape
// status-bar padding trim — applies there but not in the desktop browser/PWA,
// where the window is "landscape" whenever it's wider than tall.
if (Capacitor.isNativePlatform()) {
  document.documentElement.classList.add('native')
}

// Apply theme before React renders to avoid flash
const saved = localStorage.getItem('theme')
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
if (saved === 'dark' || (!saved && prefersDark)) {
  document.documentElement.classList.add('dark')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <App />
    </Suspense>
  </StrictMode>,
)
