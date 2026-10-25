import { useCallback, useEffect, useRef, useState } from 'react'
import { initSessionKey } from '@glance-apps/sync'
import type { SnapshotFileTransport } from '@glance-apps/sync'
import { runDirectAccessCycle, type DirectAccessCycleDeps } from '@/sync/directAccessCycle'
import { runPeopleDirectAccessCycle } from '@/people/sync/directAccessCycle'
import { CRYPTO_CONFIG } from '@/sync/engine'

// Schedules snapshot-file sync for one transport: Direct Access (a folder a
// third-party tool keeps in step, sync/directAccess.ts) or iCloud (the app's
// own container, sync/icloud.ts). dayGLANCE's hooks/useSnapshotFileSync.js:
// the poll, the foreground kick, the transport's change signal, the in-flight
// guard, the first-run question, and what only the UI can do with an outcome.
//
//   • onUnavailable: the transport reported an error (the syncing tool not
//     running, a grant revoked, iCloud away); it waits that out.
//   • onEncryptedUnreadable: the file is an envelope this device holds the
//     wrong key for, and the transport never writes over it. Nothing else will
//     happen until the user acts.
//   • onKeyNeeded: the file is an envelope (or this device wants to write one)
//     and no key or passphrase is in memory. The cached key is tried first,
//     once per session; only when that fails is the passphrase prompt raised.
//   • firstRun: a transport whose first-run decision is open (iCloud on a
//     fresh install) found cloud data and no data of this device's own. The
//     loop stops until the user answers: restoring silently is what the
//     question exists to prevent. Picking a folder is Direct Access's decision,
//     so it never asks.
//
// Each cycle runs the chore file, then People's (people/sync/directAccessCycle.ts),
// each with its own carried state. The key prompts are shared and raised at
// most once a cycle: both files use the one key.
//
// The in-flight guard is SHARED across instances: two transports must never
// merge into the store at once, since each builds its payload from the store
// and applies the merge back. A cycle skipped under the guard retries once,
// two seconds later; a retry that still finds it held leaves it to the next
// poll tick (dayGLANCE: without the retry, two instances on one cadence starved
// each other on every tick).

/** A snapshot file the shared cycle runs over. */
export type SnapshotFile = SnapshotFileTransport & { isAvailable: () => boolean | Promise<boolean> }

/** What the hook needs of a transport: the chore file, People's file, the switch. */
export interface FileTierTransport extends SnapshotFile {
  id?: string
  pollMs: number
  peopleFile: SnapshotFile
  isSupported: () => boolean
  isEnabled: () => boolean
  /** Records the first-run answer; transports that never ask need not have it. */
  setEnabled?: (enabled: boolean) => void
  onChanged?: (cb: () => void) => (() => void) | void
}

export interface FirstRunInfo {
  /** Which file asked; its data is what would be restored. */
  file: 'chores' | 'people'
  data: Record<string, unknown>
  lastModified: string | null
}

export interface UseSnapshotFileSyncArgs {
  transport: FileTierTransport
  /** False until the data layer is usable. */
  ready?: boolean
  onUnavailable?: (error: string) => void
  onEncryptedUnreadable?: () => void
  onKeyNeeded?: () => void
  /** Loads the file-tier key this device cached; tried once per session before any prompt. */
  restoreKey?: () => Promise<boolean>
  /** The chore cycle's other dependencies (a transport's own data check; tests). */
  cycleDeps?: Omit<DirectAccessCycleDeps, 'transport'>
  /** The People cycle's other dependencies. */
  peopleCycleDeps?: Omit<DirectAccessCycleDeps, 'transport'>
}

export interface UseSnapshotFileSyncResult {
  /** Runs a cycle now; resolves to the transport error it left, or null. */
  runSync: () => Promise<string | null>
  lastError: string | null
  firstRun: FirstRunInfo | null
  acceptFirstRun: () => void
  declineFirstRun: () => void
}

/** How long a cycle skipped under the in-flight guard waits before its one retry. */
export const SKIPPED_RETRY_MS = 2000

// One guard for every instance (see above).
const fileTierLock = { held: false }

type Outcome = Awaited<ReturnType<typeof runDirectAccessCycle>>['outcome']

export function useSnapshotFileSync({
  transport,
  ready = true,
  onUnavailable,
  onEncryptedUnreadable,
  onKeyNeeded,
  restoreKey,
  cycleDeps,
  peopleCycleDeps,
}: UseSnapshotFileSyncArgs): UseSnapshotFileSyncResult {
  const enabled = transport.isSupported()
  const [lastErrorState, setLastErrorState] = useState<string | null>(null)
  // Read back by runSync's caller right after the cycle, before a re-render.
  const lastErrorRef = useRef<string | null>(null)
  const setLastError = (e: string | null) => { lastErrorRef.current = e; setLastErrorState(e) }
  const [firstRun, setFirstRun] = useState<FirstRunInfo | null>(null)
  // State lands a render too late to stop the next poll tick, and merging then
  // is exactly the silent restore the question exists to prevent.
  const firstRunPendingRef = useRef(false)

  const callbacksRef = useRef({ onUnavailable, onEncryptedUnreadable, onKeyNeeded, restoreKey, cycleDeps, peopleCycleDeps })
  callbacksRef.current = { onUnavailable, onEncryptedUnreadable, onKeyNeeded, restoreKey, cycleDeps, peopleCycleDeps }
  const readyRef = useRef(ready)
  readyRef.current = ready

  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Carried between cycles: the eviction clock, the write throttle stamp and the pending relay.
  const cycleStateRef = useRef<Parameters<typeof runDirectAccessCycle>[1]>({ missingSince: 0, lastWriteAt: 0 })
  const peopleStateRef = useRef<Parameters<typeof runDirectAccessCycle>[1]>({ missingSince: 0, lastWriteAt: 0 })
  const keyRestoreTriedRef = useRef(false)

  const runCycle = async (isRetry = false): Promise<void> => {
    if (!enabled || !readyRef.current || firstRunPendingRef.current) return
    // Switched off on this device: fully inert, nothing read is applied and
    // nothing is written, so the file and other devices are untouched.
    if (!transport.isEnabled()) return
    if (fileTierLock.held) {
      if (!isRetry && retryRef.current === null) {
        retryRef.current = setTimeout(() => {
          retryRef.current = null
          void runCycleRef.current(true)
        }, SKIPPED_RETRY_MS)
      }
      return
    }
    fileTierLock.held = true
    let rerunWithKey = false
    try {
      if (!(await transport.isAvailable())) return
      const keyWanted = async (): Promise<boolean> => {
        if (keyRestoreTriedRef.current) return false
        keyRestoreTriedRef.current = true
        try { return !!(await (callbacksRef.current.restoreKey ?? (() => initSessionKey(CRYPTO_CONFIG)))()) }
        catch { return false }
      }
      let prompted = false
      const prompt = (fn?: () => void) => { if (!prompted) { prompted = true; fn?.() } }
      // True when the cached key was restored and the cycle should run again with it.
      const keyOutcome = async (outcome: Outcome): Promise<boolean> => {
        if (outcome.kind === 'skipped' && outcome.reason === 'encrypted-unreadable') {
          if (!outcome.needsKey) prompt(callbacksRef.current.onEncryptedUnreadable)
          else if (await keyWanted()) return true
          else prompt(callbacksRef.current.onKeyNeeded)
        } else if ((outcome.kind === 'skipped' && outcome.reason === 'key-needed') || (outcome.kind === 'merged' && outcome.keyNeeded)) {
          if (await keyWanted()) return true
          prompt(callbacksRef.current.onKeyNeeded)
        }
        return false
      }
      // A first-run question stops the loop; the answer resumes it.
      const asked = (outcome: Outcome, file: FirstRunInfo['file']): boolean => {
        if (outcome.kind !== 'prompted') return false
        firstRunPendingRef.current = true
        const info = outcome.info as { data?: Record<string, unknown>; lastModified?: string | null }
        setFirstRun({ file, data: info.data ?? {}, lastModified: info.lastModified ?? null })
        return true
      }

      const { state, outcome } = await runDirectAccessCycle({ transport, ...callbacksRef.current.cycleDeps }, cycleStateRef.current)
      cycleStateRef.current = state
      if (asked(outcome, 'chores')) return
      if (outcome.kind === 'error') {
        console.error(`[${transport.id ?? 'file-tier'}] unavailable:`, outcome.error)
        setLastError(outcome.error)
        callbacksRef.current.onUnavailable?.(outcome.error)
        return
      }
      if (await keyOutcome(outcome)) { rerunWithKey = true; return }
      if (outcome.kind === 'merged' || outcome.kind === 'seeded' || (outcome.kind === 'skipped' && outcome.reason === 'unchanged')) {
        setLastError(null)
      }

      // People's file, through the same transport. An error here is logged
      // rather than shown: the chore file reports the transport.
      if (await transport.peopleFile.isAvailable()) {
        try {
          const people = await runPeopleDirectAccessCycle({ transport: transport.peopleFile, ...callbacksRef.current.peopleCycleDeps }, peopleStateRef.current)
          peopleStateRef.current = people.state
          if (asked(people.outcome, 'people')) return
          if (people.outcome.kind === 'error') console.warn(`[${transport.id ?? 'file-tier'}] People file unavailable:`, people.outcome.error)
          else if (await keyOutcome(people.outcome)) rerunWithKey = true
        } catch (err) {
          console.error(`[${transport.id ?? 'file-tier'}] People cycle failed:`, (err as Error)?.message ?? err)
        }
      }
    } catch (err) {
      // A transport that throws (rather than answering an error object) must
      // not surface as an unhandled rejection from a timer; the next poll
      // retries exactly as it does for a skipped cycle.
      console.error(`[${transport.id ?? 'file-tier'}] sync cycle failed:`, (err as Error)?.message ?? err)
    } finally {
      fileTierLock.held = false
    }
    if (rerunWithKey) await runCycleRef.current()
  }

  // Stable entry point: timers and listeners call through it and always reach
  // the latest closure.
  const runCycleRef = useRef(runCycle)
  runCycleRef.current = runCycle
  const runSync = useCallback(async () => { await runCycleRef.current(); return lastErrorRef.current }, [])

  // Both answers record a decision so the question never returns.
  const acceptFirstRun = useCallback(() => {
    transport.setEnabled?.(true)
    setFirstRun(null)
    firstRunPendingRef.current = false
    void runCycleRef.current()
  }, [transport])

  const declineFirstRun = useCallback(() => {
    // Off on this device: the isEnabled gate returns early from here on, so the
    // cloud copy is never read or written from it. Reversible in Cloud Sync.
    transport.setEnabled?.(false)
    setFirstRun(null)
    firstRunPendingRef.current = false
  }, [transport])

  // Once on startup, once the data layer is ready.
  useEffect(() => {
    if (!enabled || !ready) return
    void runSync()
  }, [enabled, ready, runSync])

  // Poll. The tool or the daemon handles the network; we read the local file.
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

  // The transport's push signal: a folder picked or back, a file changed
  // remotely. A cycle already running makes this a skip, and its retry picks
  // the change up.
  useEffect(() => {
    if (!enabled || !transport.onChanged) return
    const off = transport.onChanged(() => { void runSync() })
    return () => { if (typeof off === 'function') off() }
  }, [enabled, transport, runSync])

  // A retry armed just before unmount must not run against a dead instance.
  useEffect(() => {
    if (!enabled) return
    return () => {
      if (retryRef.current !== null) clearTimeout(retryRef.current)
      retryRef.current = null
    }
  }, [enabled])

  return { runSync, lastError: lastErrorState, firstRun, acceptFirstRun, declineFirstRun }
}
