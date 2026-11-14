import { createKey, SOURCE_APPS } from '@glance-apps/intents'

// The id dayGLANCE gives the task it makes from a lastGLANCE create, worked out
// here so lastglance_send_to_dayglance can hand it to the assistant before
// dayGLANCE has even picked the intent up.
//
// dayGLANCE's handleIntent keys a create on createKey(source_app,
// source_entity_id, due), the due exactly as sent (empty for the inbox), and
// makes the task id from that key with its deterministicTaskId: the key's
// SHA-256, first 16 bytes, as a version 4 UUID. That second step is copied
// here; dayglanceTaskId.test.ts holds it to ids dayGLANCE's own function
// produced. Moving it into @glance-apps/intents beside createKey, so both apps
// import one copy, is krelltunez/lastGLANCE#455.

export async function dayglanceTaskId(choreSyncId: string, due: string | undefined): Promise<string> {
  const key = await createKey(SOURCE_APPS.LASTGLANCE, choreSyncId, due)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)))
  hash[6] = (hash[6] & 0x0f) | 0x40 // version 4
  hash[8] = (hash[8] & 0x3f) | 0x80 // variant
  const h = [...hash.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
