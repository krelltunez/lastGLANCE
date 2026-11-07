import { useCallback, useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { launcherPromoInfo } from '@/native/launcherBridge'
import { isHeadlessRefresh } from '@/headless/headlessMode'
import {
  DISMISSED_EVENT, dismissPromo, isPromoDismissed, promoEntry, promoLink, readFirstSeen, showPromoCard,
  type PromoInfo, type PromoLink,
} from '@/native/launcherPromo'

export interface LauncherPromo {
  // The Settings entry's link, or null to show no entry.
  entry: PromoLink | null
  // Whether the one-time card shows at the top of Settings.
  card: boolean
  // "Not now": hides the card for good on this device.
  dismiss: () => void
}

// The GLANCElauncher promotion for the Settings panel (src/native/launcherPromo.ts
// holds the rules). Asks the shell once when Settings opens, and again when
// the app comes back to the foreground, so a launcher installed from the link
// hides both as soon as the user returns.
export function useLauncherPromo(): LauncherPromo {
  const platform = Capacitor.getPlatform()
  const channel = import.meta.env.VITE_BUILD_CHANNEL
  const headless = isHeadlessRefresh()
  const [info, setInfo] = useState<PromoInfo | null>(null)
  const [dismissed, setDismissed] = useState(isPromoDismissed)
  const [firstSeen] = useState(readFirstSeen)
  const [now] = useState(Date.now)

  // Only where there is something to offer: no native call on web, iOS, or a
  // channel with no link.
  const possible = !headless && platform === 'android' && promoLink(channel) !== null

  useEffect(() => {
    if (!possible) return
    let live = true
    const look = () => {
      void launcherPromoInfo().then(next => { if (live) setInfo(next) })
    }
    const onVisible = () => { if (document.visibilityState === 'visible') look() }
    const onDismissed = () => setDismissed(true)
    look()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener(DISMISSED_EVENT, onDismissed)
    return () => {
      live = false
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener(DISMISSED_EVENT, onDismissed)
    }
  }, [possible])

  const dismiss = useCallback(() => {
    dismissPromo()
    setDismissed(true)
  }, [])

  const inputs = { platform, channel, info, headless }
  return {
    entry: promoEntry(inputs),
    card: showPromoCard({ ...inputs, firstSeen, dismissed, now }),
    dismiss,
  }
}
