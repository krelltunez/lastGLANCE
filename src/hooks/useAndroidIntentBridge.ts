import { useEffect, useRef } from 'react'
import type { PluginListenerHandle } from '@capacitor/core'
import { handleIntent, type IntentResult } from '@/intents/handleIntent'
import { buildIntentContext } from '@/intents/intentContext'
import { BROADCAST_ACTION_MAP } from '@/intents/androidIntents'
import {
  isAndroid,
  nativeGetPendingIntent,
  nativeReportIntentResult,
  addPendingIntentListener,
} from '@/native/intentsBridge'

// The Android/Tasker intents transport bridge (see
// docs/tasker-intents-architecture.md §3.2), ported to Capacitor. Mounted once
// near the app root. It:
//   1. drains the native pending-intent slot on mount (catches app-opened-via-
//      intent / cold start), on the plugin's `pendingIntent` event (a live
//      intent while running), and on return to foreground;
//   2. MAPS the fully-qualified action to the short handler constant (the
//      action-string gotcha, §5);
//   3. runs the pure handleIntent(), then reports the result back to native
//      under the ORIGINAL action so the sender's %action matches.
//
// No-op off Android. `onChanged` refreshes derived UI (the heatmap) after a
// mutating action.
export function useAndroidIntentBridge(onChanged?: () => void): void {
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged

  useEffect(() => {
    if (!isAndroid()) return

    let cancelled = false
    let listener: PluginListenerHandle | null = null
    // The pending slot is single-depth; guard against overlapping drains and, if
    // a new intent arrived while we were busy, drain again once we're done.
    let draining = false
    let rerun = false

    const drainOnce = async (): Promise<void> => {
      const intent = await nativeGetPendingIntent()
      if (!intent || cancelled) return
      const { action, payload } = intent
      const mapped = BROADCAST_ACTION_MAP[action] ?? action
      let result: IntentResult
      try {
        result = await handleIntent(mapped, payload, buildIntentContext(() => onChangedRef.current?.()))
      } catch (err) {
        result = { success: false, error: err instanceof Error ? err.message : String(err) }
      }
      // Report under the ORIGINAL fully-qualified action, not the mapped one.
      await nativeReportIntentResult(action, JSON.stringify(result))
    }

    const drain = async (): Promise<void> => {
      if (draining) {
        rerun = true
        return
      }
      draining = true
      try {
        do {
          rerun = false
          await drainOnce()
        } while (rerun && !cancelled)
      } finally {
        draining = false
      }
    }

    addPendingIntentListener(() => { void drain() }).then(h => {
      if (cancelled) h?.remove()
      else listener = h
    })

    // Cold start / app opened via an Activity intent: the payload is already in
    // the slot before any event fires, so drain immediately on mount.
    void drain()

    const onVisibility = () => {
      if (document.visibilityState === 'visible') void drain()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      listener?.remove()
    }
  }, [])
}
