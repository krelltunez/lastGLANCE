import { filenameFor } from '@glance-apps/intents'
import type { ChoreWithLastCompletion } from '@/types'
import { getIntentsConfig, isIntentsConfigured, addActivityEntry } from './config'
import { isDbIntentsEnabled } from './dbConfig'
import { sendCreateIntent } from './dbTransport'
import { buildAuthHeader, ensureFolder, putFile } from './webdav'
import { buildCreateEnvelope, IntentsKeyMissingError } from './buildCreateEnvelope'

export async function emitCreateIntent(chore: ChoreWithLastCompletion): Promise<boolean> {
  // TRANSPORT SELECTION. When the per-user GLANCEvault DB intents transport is
  // enabled, send there. Otherwise fall through to the WebDAV transport, which
  // remains the default and is unchanged below. An app runs one or the other.
  if (isDbIntentsEnabled()) return sendCreateIntent(chore)

  const config = getIntentsConfig()
  if (!isIntentsConfigured(config)) return false

  const authHeader = buildAuthHeader(config.webdavUsername, config.webdavPassword)

  try {
    const envelope = await buildCreateEnvelope(chore, config.encryptionEnabled)

    const filename = `${envelope.event_id}.json`
    const content = JSON.stringify(envelope)

    await ensureFolder(config.webdavUrl, config.folderPath, authHeader)
    await putFile(config.webdavUrl, config.folderPath, filename, content, authHeader)

    addActivityEntry({ type: 'sent', message: `Sent "${chore.name}" to dayGLANCE` })
    return true
  } catch (err) {
    if (err instanceof IntentsKeyMissingError) {
      addActivityEntry({ type: 'error', message: 'intents encryption setup incomplete — open Settings to complete setup' })
      return false
    }
    const message = err instanceof Error ? err.message : String(err)
    addActivityEntry({ type: 'error', message: `Failed to send "${chore.name}" to dayGLANCE`, detail: message })
    return false
  }
}

// Re-export filenameFor for use in emitter context if needed
export { filenameFor }
