import { useEffect, useRef } from 'react'
import { pushDismiss, dismissTop } from '@/utils/dismissStack'

let listening = false

// One listener for the whole app: with a listener per surface, every open
// window closed on a single Escape, not just the top one.
function listen() {
  if (listening) return
  listening = true
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape') dismissTop()
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
    listen()
    return pushDismiss(() => ref.current())
  }, [])
}
