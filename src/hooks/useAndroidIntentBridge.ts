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
import { ackLauncherIntents, drainLauncherIntents } from '@/native/launcherBridge'
import type { LauncherRefreshHooks } from '@/intents/launcherWrites'
import { drainLauncherQueue } from '@/intents/launcherQueue'

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
// The GLANCElauncher's writes (docs/launcher-integration.md) share the wake
// signal and the drain but not the slot or the toggle: its receiver queues them
// natively behind the launcher permission, and each drain handles that queue
// first (src/intents/launcherQueue.ts): writes before refreshes, each taken off
// the native queue only once handled, and deduped on its client id. No RESULT
// is reported for them; the launcher reads the next snapshot.
//
// No-op off Android. `onChanged` refreshes derived UI (the heatmap) after a
// mutating action.
export function useAndroidIntentBridge(onChanged?: () => void, launcherHooks?: LauncherRefreshHooks): void {
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  const hooksRef = useRef(launcherHooks)
  hooksRef.current = launcherHooks

  useEffect(() => {
    if (!isAndroid()) return

    let cancelled = false
    let listener: PluginListenerHandle | null = null
    // The pending slot is single-depth; guard against overlapping drains and, if
    // a new intent arrived while we were busy, drain again once we're done.
    let draining = false
    let rerun = false

    const drainLauncher = async (): Promise<void> => {
      await drainLauncherQueue({
        entries: await drainLauncherIntents(),
        ctx: () => buildIntentContext(() => onChangedRef.current?.(), 'GLANCElauncher'),
        ack: ackLauncherIntents,
        hooks: hooksRef.current ?? {},
        cancelled: () => cancelled,
      })
    }

    const drainOnce = async (): Promise<void> => {
      await drainLauncher()
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

    // Asked by the native side before it closes this page after it stopped
    // answering the launcher in the background (launcher/LauncherPageRetire.kt).
    // Called as a script handed to the page directly, so it answers synchronously.
    // Every write the app makes lands within moments, and the native side only
    // asks after two minutes in the background, so reaching here is the answer.
    const retireCheck = (): string => 'ok'
    ;(window as unknown as { __lgRetireCheck?: () => string }).__lgRetireCheck = retireCheck

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
      const w = window as unknown as { __lgRetireCheck?: () => string }
      if (w.__lgRetireCheck === retireCheck) delete w.__lgRetireCheck
    }
  }, [])
}
