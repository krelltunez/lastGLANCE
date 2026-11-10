import { useCallback, useEffect, useState } from 'react'
import { desktopBridge } from '@/native/desktop'

// The desktop app's "update available" notice (docs/desktop-app.md, section
// 11): asks main every 6 hours and on return to the app; main answers with a
// newer release that has a download for this OS, or null. Dismissing hides
// that version for good; a newer one shows again. Off the desktop, and on the
// Mac App Store build, there is never anything to show.

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_MS = 15 * 1000
const DISMISSED_KEY = 'lg_update_dismissed'

export interface UpdateNotice {
  version: string
  url: string
}

function dismissedVersion(): string | null {
  try { return localStorage.getItem(DISMISSED_KEY) } catch { return null }
}

export function useUpdateNotice(): { update: UpdateNotice | null; dismiss: () => void } {
  const [update, setUpdate] = useState<UpdateNotice | null>(null)

  useEffect(() => {
    const desktop = desktopBridge()
    if (!desktop || desktop.info.isMAS) return
    let live = true
    const check = () => {
      desktop.shell.latestRelease().then((r) => {
        if (!live) return
        setUpdate(r && r.version !== dismissedVersion() ? r : null)
      }).catch(() => {})
    }
    const first = setTimeout(check, FIRST_CHECK_MS)
    const every = setInterval(check, CHECK_EVERY_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') check() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      live = false
      clearTimeout(first)
      clearInterval(every)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const dismiss = useCallback(() => {
    setUpdate((u) => {
      if (u) { try { localStorage.setItem(DISMISSED_KEY, u.version) } catch { /* this session only */ } }
      return null
    })
  }, [])

  return { update, dismiss }
}
