import { useEffect } from 'react'
import { getDbIntentsConfig } from '@/intents/dbConfig'
import { flushIntents } from '@/intents/flushIntents'

// Drives OUTBOUND intents delivery on the same cadence the receive pollers use:
// once on mount (drain any entries persisted from a previous session, e.g. an
// intent enqueued then the app was closed before delivery), whenever the tab
// becomes visible, and on the intents poll interval. Enqueue itself also
// triggers a flush; this hook is the backstop that guarantees persisted entries
// are retried even with no new activity. The outbox in-flight lock guards
// overlap, so these triggers never fight each other.
export function useOutboxFlush(): void {
  useEffect(() => {
    const run = () => { flushIntents().catch(() => { /* surfaced via deliverers/outbox */ }) }

    run() // mount: drain anything left over from a previous session

    const intervalMs = getDbIntentsConfig().pollIntervalMinutes * 60 * 1000
    const interval = setInterval(run, intervalMs)

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') run()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])
}
