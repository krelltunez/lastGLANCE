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
import { getSyncPassphrase } from '@glance-apps/sync'
import { loadVaultIntentsRootKey } from '@/intents/vaultIntentsKeyStore'
import { routeIncomingVaultRow, KeyNotAvailableError } from '@/intents/routeIncoming'
import { ensureVaultIntentsKey, setupVaultIntentsEncryption } from '@/intents/setupVaultIntentsEncryption'
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
      //
      // Decrypt with the VAULT intents key — the SAME slot the vault deliverer
      // encrypts with (loadVaultIntentsRootKey), NOT the WebDAV intents key. The
      // two transports derive different keys from different salts, so using the
      // WebDAV slot here fails: absent in a vault-only setup ("encryption not set
      // up"), or a key mismatch when both are configured.
      await routeIncomingVaultRow(row, {
        loadRootKey: loadVaultIntentsRootKey,
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

    // Best-effort, SILENT self-heal of the vault intents key. The "enabled" flag
    // lives in localStorage while the derived key lives in IndexedDB, so the two
    // can desync — IndexedDB eviction (e.g. Safari/ITP after ~7 days), cleared
    // site data, a PWA reinstall, or first run on a device set up elsewhere all
    // leave us enabled-but-keyless. When that happens EVERY received intent fails
    // to decrypt and is eventually dropped. If the sync passphrase is in memory we
    // re-derive + re-cache the key here so incoming intents decrypt without the
    // user having to re-save Integration settings. We never PROMPT from the poll
    // (promptForPassphrase -> null): a missing passphrase simply leaves the key
    // absent until the next poll (or a manual re-save) finds it. ensureVaultIntentsKey
    // short-circuits to a single cached-key read once a key is present, so calling
    // it every poll is cheap and only derives at most once.
    async function selfHealVaultKey() {
      try {
        await ensureVaultIntentsKey({
          loadCachedKey: loadVaultIntentsRootKey,
          getPassphrase: getSyncPassphrase,
          promptForPassphrase: async () => null,
          derive: setupVaultIntentsEncryption,
        })
      } catch {
        // Self-heal is opportunistic; never let it block the receive drain.
      }
    }

    async function poll() {
      if (!isDbIntentsEnabled()) return
      await selfHealVaultKey()
      try {
        await receiveAllIntents({
          getCursor: getReceiveCursor,
          setCursor: setReceiveCursor,
          listPage: (since) => listIntentsPage(since),
          processRow,
          recordFailure: recordReceiveFailure,
          clearFailure: clearReceiveFailure,
          onGiveUp: (row, err, failures) => {
            // When the failure is a missing key (not a genuinely bad row), the
            // generic decrypt-error detail is a dead end. Surface the one action
            // that actually fixes it so the user isn't left guessing.
            const keyMissing = err instanceof KeyNotAvailableError
            addActivityEntry({
              type: 'error',
              message: `Dropping intent ${row.eventId} after ${failures} failed attempts (limit ${MAX_INTENT_RETRIES})`,
              detail: keyMissing
                ? 'This device has no GLANCEvault intents encryption key cached. Open Integration settings → GLANCEvault intents (beta) and Save to re-derive it (you may be asked for your sync passphrase).'
                : err instanceof Error ? err.message : String(err),
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
