import { useEffect, useRef } from 'react'
import type { Envelope, IntentEventRow } from '@glance-apps/intents'
import { db } from '@/db/client'
import { logCompletion } from '@/db/queries'
import { addActivityEntry } from '@/intents/config'
import {
  getDbIntentsConfig,
  isDbIntentsEnabled,
  getReceiveCursor,
  setReceiveCursor,
  recordReceiveFailure,
  clearReceiveFailure,
} from '@/intents/dbConfig'
import { listIntentsPage, receiveAllIntents, MAX_INTENT_RETRIES } from '@/intents/dbTransport'
import { loadIntentsRootKey } from '@/intents/intentsKeyStore'
import { routeIncomingVaultRow } from '@/intents/routeIncoming'
import { processNotifyEnvelope } from '@/intents/processNotifyEnvelope'

// Drives the GLANCEvault DB intents receive poll on the SAME cadence the WebDAV
// intents poller uses: once on startup, again whenever the tab becomes visible
// (focus), and on a fixed interval. No push/real-time path is added here; if
// GLANCEvault sync grows one, intents can piggyback on it later.
//
// This hook is gated by isDbIntentsEnabled(): when the DB intents transport is
// off it does nothing, so it can be mounted alongside useIntentsPoller (the
// WebDAV poller) and only the enabled transport runs.
export function useDbIntentsPoller(onNewCompletion?: () => void): void {
  const onNewCompletionRef = useRef<(() => void) | undefined>(onNewCompletion)
  useEffect(() => { onNewCompletionRef.current = onNewCompletion }, [onNewCompletion])

  useEffect(() => {
    async function processRow(row: IntentEventRow): Promise<void> {
      // Route by the row's `encrypted` flag. A NON-encrypted row on the vault is
      // a zero-knowledge contract violation: routeIncomingVaultRow rejects it
      // (logs loudly, advances past it) and never routes plaintext into the app.
      await routeIncomingVaultRow(row, {
        loadRootKey: loadIntentsRootKey,
        handleEnvelope: processEnvelope,
        addActivityEntry,
      })
    }

    async function processEnvelope(envelope: Envelope) {
      await processNotifyEnvelope(envelope, {
        getChore: (syncId) => db.chores.where('sync_id').equals(syncId).first(),
        logCompletion,
        addActivityEntry,
        isAlreadyLogged: (syncId) => db.completionEvents.where('sync_id').equals(syncId).count().then(n => n > 0),
        dispatchChoreLogged: () => window.dispatchEvent(new CustomEvent('lg:chore-logged')),
        onNewCompletion: () => onNewCompletionRef.current?.(),
      })
    }

    async function poll() {
      if (!isDbIntentsEnabled()) return
      try {
        await receiveAllIntents({
          getCursor: getReceiveCursor,
          setCursor: setReceiveCursor,
          listPage: (since) => listIntentsPage(since),
          processRow,
          recordFailure: recordReceiveFailure,
          clearFailure: clearReceiveFailure,
          onGiveUp: (row, err, failures) => {
            addActivityEntry({
              type: 'error',
              message: `Dropping intent ${row.eventId} after ${failures} failed attempts (limit ${MAX_INTENT_RETRIES})`,
              detail: err instanceof Error ? err.message : String(err),
            })
          },
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        addActivityEntry({ type: 'error', message: 'Failed to poll GLANCEvault intents', detail: message })
      }
    }

    poll()

    const intervalMs = getDbIntentsConfig().pollIntervalMinutes * 60 * 1000
    const interval = setInterval(poll, intervalMs)

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') poll()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])
}
