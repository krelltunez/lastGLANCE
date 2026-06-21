import { useEffect, useRef } from 'react'
import {
  parseEnvelope,
  parseEncryptedEnvelope,
  NoKeyError,
  WrongKeyError,
  NotEncryptedError,
  MalformedEnvelopeError,
  deriveEnvelopeKey,
} from '@glance-apps/intents'
import type { IntentEventRow } from '@glance-apps/intents'
import { db } from '@/db/client'
import { logCompletion } from '@/db/queries'
import { addActivityEntry } from '@/intents/config'
import {
  getDbIntentsConfig,
  isDbIntentsEnabled,
  getReceiveCursor,
  setReceiveCursor,
} from '@/intents/dbConfig'
import { listIntentsPage, receiveAllIntents } from '@/intents/dbTransport'
import { loadIntentsRootKey } from '@/intents/intentsKeyStore'
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
      // parseIntentRow already decoded the base64 envelope into a structured
      // object; route it by its `encrypted` flag exactly as the WebDAV read path
      // does, then hand the validated envelope to the shared intent handler.
      const data = row.envelope
      const isEncrypted = typeof data === 'object' && data !== null && (data as Record<string, unknown>).encrypted === true

      if (isEncrypted) {
        const rootKey = await loadIntentsRootKey()
        if (!rootKey) {
          addActivityEntry({ type: 'error', message: 'encrypted intent received but intents encryption not set up on this device' })
          return
        }
        let envelope
        try {
          envelope = await parseEncryptedEnvelope(data, (salt) => deriveEnvelopeKey(rootKey, salt))
        } catch (err) {
          let message = 'Failed to decrypt intent'
          if (err instanceof NoKeyError) message = 'No encryption key available to decrypt intent'
          else if (err instanceof WrongKeyError) message = 'decryption failed (root key mismatch — try re-running intents encryption setup)'
          else if (err instanceof NotEncryptedError) message = 'Intent is not encrypted as expected'
          else if (err instanceof MalformedEnvelopeError) {
            addActivityEntry({ type: 'warning', message: 'Malformed encrypted envelope', detail: err.message })
            return
          }
          addActivityEntry({ type: 'error', message, detail: err instanceof Error ? err.message : String(err) })
          return
        }
        await processEnvelope(envelope)
        return
      }

      let envelope
      try {
        envelope = parseEnvelope(data)
      } catch {
        // Malformed plaintext envelope — skip this row but let the cursor advance
        // past it (it is consumed; re-listing would just hit the same bad row).
        return
      }
      await processEnvelope(envelope)
    }

    async function processEnvelope(envelope: Awaited<ReturnType<typeof parseEnvelope>>) {
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
