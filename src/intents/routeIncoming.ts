// Vault intents receive routing (stage 2a).
//
// Extracted from the DB intents poller so the routing decision — including the
// hard plaintext rejection below — is unit-testable without mounting the hook.
//
// ZERO-KNOWLEDGE CONTRACT: every intent on the GLANCEvault transport MUST be
// encrypted. A non-encrypted row on the vault is a contract violation, never a
// thing we silently accept. So the `encrypted !== true` branch REJECTS the row
// (logs loudly, advances the cursor past it) and NEVER calls parseEnvelope —
// plaintext is not routed into the app under any circumstance. The WebDAV
// receive path is unchanged and still accepts its existing envelope policy.

import {
  parseEncryptedEnvelope,
  deriveEnvelopeKey,
  NoKeyError,
  WrongKeyError,
  NotEncryptedError,
  MalformedEnvelopeError,
} from '@glance-apps/intents'
import type { Envelope, IntentEventRow } from '@glance-apps/intents'

type ActivityEntry = { type: 'sent' | 'received' | 'warning' | 'error'; message: string; detail?: string }

export interface RouteIncomingDeps {
  // Loads the root key used to decrypt vault rows.
  loadRootKey: () => Promise<CryptoKey | null>
  // Handles a successfully-decrypted envelope (logging the completion, etc.).
  handleEnvelope: (envelope: Envelope) => Promise<void>
  addActivityEntry: (entry: ActivityEntry) => void
}

// Outcome is returned for tests/diagnostics. In all non-'processed' cases the
// caller still advances the cursor past the row (the receive drain treats a
// normal return as "consumed"); only a thrown error would pause the drain.
export type RouteOutcome = 'processed' | 'rejected' | 'skipped'

export async function routeIncomingVaultRow(
  row: IntentEventRow,
  deps: RouteIncomingDeps,
): Promise<RouteOutcome> {
  const data = row.envelope
  const isEncrypted =
    typeof data === 'object' && data !== null && (data as Record<string, unknown>).encrypted === true

  if (!isEncrypted) {
    // PLAINTEXT ON THE VAULT — reject. Log loudly, advance past it (return
    // normally so the cursor moves and the channel can't wedge), and do NOT call
    // parseEnvelope: a plaintext row is never routed into the app.
    // eslint-disable-next-line no-console
    console.error(
      `[lastglance] intents: REJECTING non-encrypted intent ${row.eventId} on the GLANCEvault transport. Plaintext over the vault is a zero-knowledge contract violation; advancing past it without routing.`,
    )
    deps.addActivityEntry({
      type: 'error',
      message: `Rejected non-encrypted intent ${row.eventId} on GLANCEvault (plaintext is not allowed on the vault)`,
    })
    return 'rejected'
  }

  const rootKey = await deps.loadRootKey()
  if (!rootKey) {
    deps.addActivityEntry({
      type: 'error',
      message: `encrypted intent ${row.eventId} received but intents encryption not set up on this device`,
    })
    return 'skipped'
  }

  let envelope: Envelope
  try {
    envelope = await parseEncryptedEnvelope(data, (salt) => deriveEnvelopeKey(rootKey, salt))
  } catch (err) {
    let message = `Failed to decrypt intent ${row.eventId}`
    if (err instanceof NoKeyError) message = `No encryption key available to decrypt intent ${row.eventId}`
    else if (err instanceof WrongKeyError) message = `decryption failed for intent ${row.eventId} (root key mismatch — try re-running intents encryption setup)`
    else if (err instanceof NotEncryptedError) message = `Intent ${row.eventId} is not encrypted as expected`
    else if (err instanceof MalformedEnvelopeError) {
      deps.addActivityEntry({ type: 'warning', message: `Malformed encrypted envelope ${row.eventId}`, detail: err.message })
      return 'skipped'
    }
    deps.addActivityEntry({ type: 'error', message, detail: err instanceof Error ? err.message : String(err) })
    return 'skipped'
  }

  await deps.handleEnvelope(envelope)
  return 'processed'
}
