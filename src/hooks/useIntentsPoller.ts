import { useEffect, useRef } from 'react'
import {
  parseEnvelope,
  parseEncryptedEnvelope,
  parseFilename,
  NoKeyError,
  WrongKeyError,
  NotEncryptedError,
  MalformedEnvelopeError,
  deriveEnvelopeKey,
} from '@glance-apps/intents'
import { db } from '@/db/client'
import { logCompletion } from '@/db/queries'
import {
  getIntentsConfig,
  isIntentsConfigured,
  addActivityEntry,
  getPollingCursor,
  setPollingCursor,
} from '@/intents/config'
import { buildAuthHeader, listFiles, getFile } from '@/intents/webdav'
import { loadIntentsRootKey } from '@/intents/intentsKeyStore'
import { processNotifyEnvelope } from '@/intents/processNotifyEnvelope'

// How far back to look behind the stored cursor when filtering events.
// Covers the window where a device may upload an event with an earlier
// timestamp than one already processed (out-of-order WebDAV delivery).
// isAlreadyLogged guards against re-writing events within the window.
const CURSOR_LOOKBACK_MS = 60 * 60 * 1000

function cursorLookback(cursor: string, windowMs: number): string {
  const iso = cursor.replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
    '$1-$2-$3T$4:$5:$6Z',
  )
  const adjusted = new Date(new Date(iso).getTime() - windowMs)
  return adjusted.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

export function useIntentsPoller(onNewCompletion?: () => void): void {
  const onNewCompletionRef = useRef<(() => void) | undefined>(onNewCompletion)
  useEffect(() => { onNewCompletionRef.current = onNewCompletion }, [onNewCompletion])

  useEffect(() => {
    async function poll() {
      const config = getIntentsConfig()
      if (!isIntentsConfigured(config)) return

      const authHeader = buildAuthHeader(config.webdavUsername, config.webdavPassword)
      const cursor = getPollingCursor()

      let filenames: string[]
      try {
        filenames = await listFiles(config.webdavUrl, config.folderPath, authHeader)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        addActivityEntry({ type: 'error', message: 'Failed to list intent files', detail: message })
        return
      }

      // Filter by parseFilename and cursor (with lookback), sort ascending.
      // The lookback catches events uploaded with earlier timestamps than the
      // current cursor (out-of-order delivery). isAlreadyLogged prevents
      // duplicate writes for events re-examined within the window.
      const effectiveCursor = cursor ? cursorLookback(cursor, CURSOR_LOOKBACK_MS) : null
      const parsed = filenames
        .map(f => ({ filename: f, parsed: parseFilename(f) }))
        .filter(({ parsed: p }) => p !== null && (!effectiveCursor || p!.timestamp > effectiveCursor))
        .sort((a, b) => a.parsed!.timestamp.localeCompare(b.parsed!.timestamp))

      let newCursor = cursor

      for (const { filename, parsed: parsedFilename } of parsed) {
        let rawText: string
        try {
          rawText = await getFile(config.webdavUrl, config.folderPath, filename, authHeader)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          addActivityEntry({ type: 'error', message: `Failed to read intent file ${filename}`, detail: message })
          newCursor = parsedFilename!.timestamp
          continue
        }

        let data: unknown
        try {
          data = JSON.parse(rawText)
        } catch {
          newCursor = parsedFilename!.timestamp
          continue
        }

        // Check if encrypted
        const isEncrypted = typeof data === 'object' && data !== null && (data as Record<string, unknown>).encrypted === true

        if (isEncrypted) {
          const rootKey = await loadIntentsRootKey()
          if (!rootKey) {
            addActivityEntry({ type: 'error', message: 'encrypted intent received but intents encryption not set up on this device' })
            newCursor = parsedFilename!.timestamp
            continue
          }

          let envelope
          try {
            envelope = await parseEncryptedEnvelope(data, (salt) => deriveEnvelopeKey(rootKey, salt))
          } catch (err) {
            let message = 'Failed to decrypt intent file'
            if (err instanceof NoKeyError) {
              message = 'No encryption key available to decrypt intent'
            } else if (err instanceof WrongKeyError) {
              message = 'decryption failed (root key mismatch — try re-running intents encryption setup)'
            } else if (err instanceof NotEncryptedError) {
              message = 'File is not encrypted as expected'
            } else if (err instanceof MalformedEnvelopeError) {
              addActivityEntry({ type: 'warning', message: 'Malformed encrypted envelope', detail: err instanceof Error ? err.message : String(err) })
              newCursor = parsedFilename!.timestamp
              continue
            }
            addActivityEntry({ type: 'error', message, detail: err instanceof Error ? err.message : String(err) })
            newCursor = parsedFilename!.timestamp
            continue
          }

          await processEnvelope(envelope)
          newCursor = parsedFilename!.timestamp
        } else {
          let envelope
          try {
            envelope = parseEnvelope(data)
          } catch {
            newCursor = parsedFilename!.timestamp
            continue
          }

          await processEnvelope(envelope)
          newCursor = parsedFilename!.timestamp
        }
      }

      if (newCursor && newCursor !== cursor) {
        setPollingCursor(newCursor)
      }
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

    poll()

    const config = getIntentsConfig()
    const intervalMs = config.pollIntervalMinutes * 60 * 1000

    const interval = setInterval(poll, intervalMs)

    function onVisibilityChange() {
      if (document.visibilityState === 'visible') {
        poll()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [])
}
