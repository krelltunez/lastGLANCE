import { ACTIONS, SOURCE_APPS, buildEnvelope, filenameFor } from '@glance-apps/intents'
import type { ChoreWithLastCompletion } from '@/types'
import { getIntentsConfig, isIntentsConfigured, addActivityEntry } from './config'
import { buildAuthHeader, ensureFolder, putFile } from './webdav'
import dayjs from 'dayjs'

export async function emitCreateIntent(chore: ChoreWithLastCompletion): Promise<boolean> {
  const config = getIntentsConfig()
  if (!isIntentsConfigured(config)) return false

  const authHeader = buildAuthHeader(config.webdavUsername, config.webdavPassword)

  try {
    const payload = {
      title: chore.name,
      due: dayjs().format('YYYY-MM-DD'),
      all_day: true,
      source_app: SOURCE_APPS.LASTGLANCE,
      source_entity_id: String(chore.id),
    }

    const envelope = buildEnvelope({ action: ACTIONS.CREATE, payload, emittedBy: SOURCE_APPS.LASTGLANCE })

    const filename = `${envelope.event_id}.json`
    const content = JSON.stringify(envelope)

    await ensureFolder(config.webdavUrl, config.folderPath, authHeader)
    await putFile(config.webdavUrl, config.folderPath, filename, content, authHeader)

    addActivityEntry({ type: 'sent', message: `Sent "${chore.name}" to dayGLANCE` })
    return true
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    addActivityEntry({ type: 'error', message: `Failed to send "${chore.name}" to dayGLANCE`, detail: message })
    return false
  }
}

// Re-export filenameFor for use in emitter context if needed
export { filenameFor }
