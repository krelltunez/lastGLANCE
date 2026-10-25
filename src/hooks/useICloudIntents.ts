import { useEffect, useRef } from 'react'
import type { Envelope } from '@glance-apps/intents'
import { db } from '@/db/client'
import { logCompletion } from '@/db/queries'
import { addActivityEntry } from '@/intents/config'
import { isICloudIntentsEnabled, pollICloudIntents, ICLOUD_INTENTS_POLL_MS } from '@/intents/icloudIntents'
import { processNotifyEnvelope } from '@/intents/processNotifyEnvelope'
import { icloudBridge } from '@/native/icloud'
import { peopleNotifyDeps } from '@/people/notifyDeps'

// Polls the shared iCloud events folder (intents/icloudIntents.ts) for intents
// dayGLANCE left there, on dayGLANCE's two-minute cadence and on foreground.
// Each envelope goes through the same processNotifyEnvelope the WebDAV, vault
// and Direct Access polls use. The opt-in is read on every tick, so turning it
// on or off in Integrations takes effect without a reload.
export function useICloudIntents(onNewCompletion?: () => void): void {
  const onNewCompletionRef = useRef<(() => void) | undefined>(onNewCompletion)
  useEffect(() => { onNewCompletionRef.current = onNewCompletion }, [onNewCompletion])

  useEffect(() => {
    if (!icloudBridge()) return
    let running = false
    const handle = (envelope: Envelope) => processNotifyEnvelope(envelope, {
      getChore: (syncId) => db.chores.where('sync_id').equals(syncId).first(),
      logCompletion,
      addActivityEntry,
      isAlreadyLogged: (syncId) => db.completionEvents.where('sync_id').equals(syncId).count().then(n => n > 0),
      people: peopleNotifyDeps,
      dispatchChoreLogged: () => window.dispatchEvent(new CustomEvent('lg:chore-logged')),
      onNewCompletion: () => onNewCompletionRef.current?.(),
    })
    const poll = async () => {
      if (running || !isICloudIntentsEnabled()) return
      running = true
      try { await pollICloudIntents({ bridge: icloudBridge, process: handle, addActivityEntry }) }
      catch (err) { console.warn('[intent/icloud] poll failed:', (err as Error)?.message ?? err) }
      finally { running = false }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, ICLOUD_INTENTS_POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') void poll() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
}
