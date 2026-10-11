import { useEffect, useRef } from 'react'
import type { Envelope } from '@glance-apps/intents'
import { db } from '@/db/client'
import { logCompletion } from '@/db/queries'
import { addActivityEntry } from '@/intents/config'
import { getDirectAccessIntentsEnabledFlag } from '@/intents/directAccessIntentsConfig'
import { runEventSetCycle, receiveEnvelope, withEventsLock, type EventSetState } from '@/intents/eventSet'
import { processNotifyEnvelope } from '@/intents/processNotifyEnvelope'
import { directAccessTransport, type DirectAccessTransport } from '@/sync/directAccess'
import { getDeviceId } from '@/sync/deviceId'

// Polls the Direct Access event set (intents/eventSet.ts) for intents other
// apps left in the folder, on the transport's own cadence (it is a local
// file read, not a network call), on foreground, and whenever the transport
// says the folder changed. Each envelope above the cursor that is not this
// app's goes through the same processNotifyEnvelope the WebDAV and vault
// pollers use. Inert unless the opt-in is on; the deliverer (the sending
// half) shares the file lock with this loop.
export function useDirectAccessIntents(onNewCompletion?: () => void, transport: DirectAccessTransport = directAccessTransport): void {
  const onNewCompletionRef = useRef<(() => void) | undefined>(onNewCompletion)
  useEffect(() => { onNewCompletionRef.current = onNewCompletion }, [onNewCompletion])

  useEffect(() => {
    if (!getDirectAccessIntentsEnabledFlag() || !transport.isSupported()) return
    let destroyed = false
    let running = false
    let state: EventSetState = { lastWriteAt: 0, pendingWrite: null }

    const handleEnvelope = (envelope: Envelope) => processNotifyEnvelope(envelope, {
      getChore: (syncId) => db.chores.where('sync_id').equals(syncId).first(),
      logCompletion,
      addActivityEntry,
      isAlreadyLogged: (syncId) => db.completionEvents.where('sync_id').equals(syncId).count().then((n) => n > 0),
      dispatchChoreLogged: () => window.dispatchEvent(new CustomEvent('lg:chore-logged')),
      onNewCompletion: () => onNewCompletionRef.current?.(),
    })

    const run = async () => {
      if (destroyed || running) return
      if (!transport.isAvailable()) return
      running = true
      try {
        const r = await withEventsLock(() => runEventSetCycle({
          transport,
          io: {
            deviceId: getDeviceId,
            receive: (raw) => receiveEnvelope(raw, { handleEnvelope }),
          },
          state,
        }))
        state = r.state
        if (r.outcome.kind === 'error') console.warn('[intent/direct-access] unavailable:', r.outcome.error)
      } catch (err) {
        console.warn('[intent/direct-access] cycle failed:', (err as Error)?.message ?? err)
      } finally {
        running = false
      }
    }

    const timer = setInterval(() => { void run() }, transport.pollMs)
    const onVisible = () => { if (document.visibilityState === 'visible') void run() }
    document.addEventListener('visibilitychange', onVisible)
    const unsubscribe = transport.onChanged(() => { void run() })
    void run()

    return () => {
      destroyed = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      unsubscribe()
    }
  }, [transport])
}
