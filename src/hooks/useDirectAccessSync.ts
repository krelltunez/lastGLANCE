import { useCallback, useEffect, useRef, useState } from 'react'
import { initSessionKey } from '@glance-apps/sync'
import { directAccessTransport, type DirectAccessTransport } from '@/sync/directAccess'
import { runDirectAccessCycle, type DirectAccessCycleDeps } from '@/sync/directAccessCycle'
import { CRYPTO_CONFIG } from '@/sync/engine'

// Schedules Direct Access sync (sync/directAccessCycle.ts): the poll, the
// foreground kick, the transport's change signal, the one in-flight guard, and
// the three things only the UI can do with an outcome. It is dayGLANCE's
// hooks/useSnapshotFileSync.js for one transport and without the first-run
// prompt (picking the folder is the decision).
//
//   • onUnavailable: the folder reported an error (the syncing tool not
//     running, the grant revoked); the transport waits it out and re-probes.
//   • onEncryptedUnreadable: the file is an envelope, this device holds the
//     wrong key, and the folder is never written over as plaintext. Nothing
//     else will happen until the user acts.
//   • onKeyNeeded: the file is an envelope (or this device wants to write one)
//     and no key or passphrase is in memory. The cached key is tried first,
//     once per session, so a device that unlocked before is never asked again;
//     only when that fails is the passphrase prompt raised.

export interface UseDirectAccessSyncArgs {
  transport?: DirectAccessTransport
  /** False until the data layer is usable. */
  ready?: boolean
  onUnavailable?: (error: string) => void
  onEncryptedUnreadable?: () => void
  onKeyNeeded?: () => void
  /** Loads the file-tier key this device cached; tried once per session before any prompt. */
  restoreKey?: () => Promise<boolean>
  /** Test seam: the cycle's other dependencies. */
  cycleDeps?: Omit<DirectAccessCycleDeps, 'transport'>
}

/** How long a cycle skipped under the in-flight guard waits before its one retry. */
export const SKIPPED_RETRY_MS = 2000

export function useDirectAccessSync({
  transport = directAccessTransport,
  ready = true,
  onUnavailable,
  onEncryptedUnreadable,
  onKeyNeeded,
  restoreKey,
  cycleDeps,
}: UseDirectAccessSyncArgs = {}): { runSync: () => Promise<void>; lastError: string | null } {
  const enabled = transport.isSupported()
  const [lastError, setLastError] = useState<string | null>(null)

  const callbacksRef = useRef({ onUnavailable, onEncryptedUnreadable, onKeyNeeded, restoreKey, cycleDeps })
  callbacksRef.current = { onUnavailable, onEncryptedUnreadable, onKeyNeeded, restoreKey, cycleDeps }
  const readyRef = useRef(ready)
  readyRef.current = ready

  const inFlightRef = useRef(false)
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Carried between cycles: the eviction clock, the write throttle stamp and the pending relay.
  const cycleStateRef = useRef<Parameters<typeof runDirectAccessCycle>[1]>({ missingSince: 0, lastWriteAt: 0 })
  const keyRestoreTriedRef = useRef(false)

  const runCycle = async (isRetry = false): Promise<void> => {
    if (!enabled || !readyRef.current) return
    // Switched off on this device: fully inert, nothing read is applied and
    // nothing is written, so the file and other devices are untouched.
    if (!transport.isEnabled()) return
    if (inFlightRef.current) {
      // Kicked twice (a poll tick and a foreground resume together). Come back
      // once, shortly: a cycle is local file I/O and is over in milliseconds.
      // A retry that still finds the guard up leaves it to the next poll tick.
      if (!isRetry && retryRef.current === null) {
        retryRef.current = setTimeout(() => {
          retryRef.current = null
          void runCycleRef.current(true)
        }, SKIPPED_RETRY_MS)
      }
      return
    }
    if (!transport.isAvailable()) return

    inFlightRef.current = true
    const keyWanted = async (): Promise<boolean> => {
      if (keyRestoreTriedRef.current) return false
      keyRestoreTriedRef.current = true
      try { return !!(await (callbacksRef.current.restoreKey ?? (() => initSessionKey(CRYPTO_CONFIG)))()) }
      catch { return false }
    }
    let rerunWithKey = false
    try {
      const { state, outcome } = await runDirectAccessCycle({ transport, ...callbacksRef.current.cycleDeps }, cycleStateRef.current)
      cycleStateRef.current = state
      if (outcome.kind === 'error') {
        console.error('[direct-access] unavailable:', outcome.error)
        setLastError(outcome.error)
        callbacksRef.current.onUnavailable?.(outcome.error)
      } else if (outcome.kind === 'skipped' && outcome.reason === 'encrypted-unreadable') {
        if (!outcome.needsKey) callbacksRef.current.onEncryptedUnreadable?.()
        else if (await keyWanted()) rerunWithKey = true
        else callbacksRef.current.onKeyNeeded?.()
      } else if ((outcome.kind === 'skipped' && outcome.reason === 'key-needed') || (outcome.kind === 'merged' && outcome.keyNeeded)) {
        if (await keyWanted()) rerunWithKey = true
        else callbacksRef.current.onKeyNeeded?.()
      } else if (outcome.kind === 'merged' || outcome.kind === 'seeded') {
        setLastError(null)
      }
    } catch (err) {
      // A transport that throws (rather than answering an error object) must
      // not surface as an unhandled rejection from a timer; the next poll
      // retries exactly as it does for a skipped cycle.
      console.error('[direct-access] sync cycle failed:', (err as Error)?.message ?? err)
    } finally {
      inFlightRef.current = false
    }
    if (rerunWithKey) await runCycleRef.current()
  }

  // Stable entry point: timers and listeners call through it and always reach
  // the latest closure.
  const runCycleRef = useRef(runCycle)
  runCycleRef.current = runCycle
  const runSync = useCallback(() => runCycleRef.current(), [])

  // Once on startup, once the data layer is ready.
  useEffect(() => {
    if (!enabled || !ready) return
    void runSync()
  }, [enabled, ready, runSync])

  // Poll. The tool handles the network; we read and write the local file.
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => { void runSync() }, transport.pollMs)
    return () => clearInterval(timer)
  }, [enabled, transport, runSync])

  // Re-sync when the app comes back to the foreground.
  useEffect(() => {
    if (!enabled) return
    const onVisible = () => { if (document.visibilityState === 'visible') void runSync() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [enabled, runSync])

  // A folder picked or re-enabled in settings, the encrypt switch turned on, a
  // folder back from unreachable: run now rather than at the next tick.
  useEffect(() => {
    if (!enabled) return
    return transport.onChanged(() => { void runSync() })
  }, [enabled, transport, runSync])

  // A retry armed just before unmount must not run against a dead instance.
  useEffect(() => {
    if (!enabled) return
    return () => {
      if (retryRef.current !== null) clearTimeout(retryRef.current)
      retryRef.current = null
    }
  }, [enabled])

  return { runSync, lastError }
}
