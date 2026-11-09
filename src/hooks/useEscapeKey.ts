import { useEffect, useRef } from 'react'
import { pushDismiss, dismissTop } from '@/utils/dismissStack'
import { desktopBridge } from '@/native/desktop'

type EscapeEvent = Pick<KeyboardEvent, 'key' | 'target' | 'defaultPrevented' | 'preventDefault'>

// Escape typed into a field means "cancel editing", never "leave fullscreen".
function isEditable(target: EventTarget | null): boolean {
  const t = target as { tagName?: string; isContentEditable?: boolean } | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable === true)
}

/**
 * What one Escape press does. The topmost open surface closes, and the press
 * is marked handled. With nothing open, the desktop app leaves fullscreen
 * (docs/desktop-app.md): macOS does not tie Escape to its green-button
 * fullscreen, so without this only the green button or Ctrl+Cmd+F get out.
 * One press therefore closes a modal, and the next leaves fullscreen.
 * `exitFullscreen` is absent off the desktop.
 */
export function handleEscape(e: EscapeEvent, exitFullscreen?: () => void): void {
  if (e.key !== 'Escape') return
  if (dismissTop()) {
    e.preventDefault()
    return
  }
  if (!exitFullscreen || e.defaultPrevented || isEditable(e.target)) return
  exitFullscreen()
}

let listening = false

// One listener for the whole app: with a listener per surface, every open
// window closed on a single Escape, not just the top one. The desktop app
// starts it at boot (main.tsx), so Escape leaves fullscreen before any surface
// has opened; elsewhere the first surface starts it.
export function listenForEscape(): void {
  if (listening) return
  listening = true
  window.addEventListener('keydown', e => {
    const desktop = desktopBridge()
    handleEscape(e, desktop ? () => desktop.shell.exitFullscreen() : undefined)
  })
}

/**
 * Close this surface on Escape, and on Android's Back button. Only the most
 * recently opened surface responds, so nested windows close one at a time.
 */
export function useEscapeKey(handler: () => void) {
  // Callers pass inline and conditional handlers; the ref keeps the latest
  // one while the surface keeps the stack position it got when it opened.
  const ref = useRef(handler)
  ref.current = handler

  useEffect(() => {
    listenForEscape()
    return pushDismiss(() => ref.current())
  }, [])
}
