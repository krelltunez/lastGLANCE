import { ACTIONS, SOURCE_APPS, buildEnvelope, buildEncryptedEnvelope, deriveEnvelopeKey } from '@glance-apps/intents'
import type { Envelope, EncryptedEnvelope } from '@glance-apps/intents'
import type { ChoreWithLastCompletion } from '@/types'
import { loadIntentsRootKey } from './intentsKeyStore'
import dayjs from 'dayjs'

// Raised when an encrypted intent is requested but this device has not finished
// intents-encryption setup (no root key). Both transports (WebDAV and the
// GLANCEvault DB transport) catch this to surface the same "setup incomplete"
// message rather than silently sending plaintext.
export class IntentsKeyMissingError extends Error {
  constructor() {
    super('intents encryption setup incomplete')
    this.name = 'IntentsKeyMissingError'
  }
}

// Builds the outgoing CREATE envelope for a chore, encrypting it when intents
// encryption is enabled. This is the single source of truth for the envelope
// shape shared by every intents transport: WebDAV writes it to a file, the DB
// transport encodes it into a vault row via buildIntentRow. The envelope itself
// (and its stable event_id) is transport-agnostic, so re-sending the same chore
// over either transport produces a byte-identical, idempotent envelope.
export async function buildCreateEnvelope(
  chore: ChoreWithLastCompletion,
  encryptionEnabled: boolean,
): Promise<Envelope | EncryptedEnvelope> {
  const assignedUserIds = chore.assigned_user_sync_ids ?? []
  const payload = {
    title: chore.name,
    due: dayjs().format('YYYY-MM-DD'),
    all_day: true,
    source_app: SOURCE_APPS.LASTGLANCE,
    source_entity_id: chore.sync_id,
    ...(assignedUserIds.length > 0 && { assigned_user_ids: assignedUserIds }),
  }

  if (encryptionEnabled) {
    const rootKey = await loadIntentsRootKey()
    if (!rootKey) throw new IntentsKeyMissingError()
    return buildEncryptedEnvelope(
      { action: ACTIONS.CREATE, payload, emittedBy: SOURCE_APPS.LASTGLANCE },
      (salt) => deriveEnvelopeKey(rootKey, salt),
    )
  }

  return buildEnvelope({ action: ACTIONS.CREATE, payload, emittedBy: SOURCE_APPS.LASTGLANCE })
}
