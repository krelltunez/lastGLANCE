import { useEffect, useRef } from 'react'
import {
  ACTIONS,
  EVENTS,
  SOURCE_APPS,
  parseEnvelope,
  parseFilename,
  MalformedEnvelopeError,
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

        const isEncrypted = typeof data === 'object' && data !== null && (data as Record<string, unknown>).encrypted === true
        if (isEncrypted) {
          addActivityEntry({ type: 'error', message: `Skipped encrypted intent file ${filename} — cross-app encryption is not supported` })
          newCursor = parsedFilename!.timestamp
          continue
        }

        let envelope
        try {
          envelope = parseEnvelope(data)
        } catch (err) {
          if (!(err instanceof MalformedEnvelopeError)) {
            const message = err instanceof Error ? err.message : String(err)
            addActivityEntry({ type: 'error', message: `Failed to parse intent file ${filename}`, detail: message })
          }
          newCursor = parsedFilename!.timestamp
          continue
        }

        await processEnvelope(envelope)
        newCursor = parsedFilename!.timestamp
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

    poll()

    const config = getIntentsConfig()
    const intervalMs = config.pollIntervalMinutes * 60 * 1000

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
