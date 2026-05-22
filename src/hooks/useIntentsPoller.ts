import { useEffect, useRef } from 'react'
import {
  ACTIONS,
  EVENTS,
  SOURCE_APPS,
  parseEnvelope,
  parseEncryptedEnvelope,
  parseFilename,
  NoKeyError,
  WrongKeyError,
  NotEncryptedError,
  MalformedEnvelopeError,
} from '@glance-apps/intents'
import { hasEncryptionReady, getSessionKey } from '@glance-apps/sync'
import { db } from '@/db/client'
import { logCompletion } from '@/db/queries'
import {
  getIntentsConfig,
  isIntentsConfigured,
  addActivityEntry,
  getPollingCursor,
  setPollingCursor,
} from '@/intents/config'
import { buildAuthHeader, ensureFolder, listFiles, getFile } from '@/intents/webdav'
import dayjs from 'dayjs'

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

      // Filter by parseFilename and cursor, sort ascending
      const parsed = filenames
        .map(f => ({ filename: f, parsed: parseFilename(f) }))
        .filter(({ parsed: p }) => p !== null && (!cursor || p!.timestamp > cursor))
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
          if (!config.encryptionEnabled || !hasEncryptionReady()) {
            addActivityEntry({ type: 'error', message: 'Encrypted intent received but encryption not configured' })
            newCursor = parsedFilename!.timestamp
            continue
          }

          let envelope
          try {
            envelope = await parseEncryptedEnvelope(data, getSessionKey()!)
          } catch (err) {
            let message = 'Failed to decrypt intent file'
            if (err instanceof NoKeyError) {
              message = 'No encryption key available to decrypt intent'
            } else if (err instanceof WrongKeyError) {
              message = 'Wrong encryption key for intent file'
            } else if (err instanceof NotEncryptedError) {
              message = 'File is not encrypted as expected'
            } else if (err instanceof MalformedEnvelopeError) {
              message = 'Malformed encrypted envelope'
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
      if (envelope.action !== ACTIONS.NOTIFY) return

      const payload = envelope.payload
      if (payload.source_app !== SOURCE_APPS.LASTGLANCE) return
      if (payload.event !== EVENTS.COMPLETED) return

      const choreId = parseInt(payload.source_entity_id, 10)
      if (isNaN(choreId)) return

      const chore = await db.chores.get(choreId)
      if (!chore) return

      await logCompletion(choreId, {
        completedAt: payload.completed_at ?? dayjs().toISOString(),
        source: 'dayglance',
      })

      addActivityEntry({ type: 'received', message: `"${chore.name}" completed in dayGLANCE` })
      window.dispatchEvent(new CustomEvent('lg:chore-logged'))
      onNewCompletionRef.current?.()
    }

    // Ensure the intents folder exists so the first PROPFIND doesn't 403
    const initConfig = getIntentsConfig()
    if (isIntentsConfigured(initConfig)) {
      const initAuth = buildAuthHeader(initConfig.webdavUsername, initConfig.webdavPassword)
      ensureFolder(initConfig.webdavUrl, initConfig.folderPath, initAuth).catch(() => {/* non-fatal */})
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
