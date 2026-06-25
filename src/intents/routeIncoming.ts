// Vault intents receive routing (stage 2a; decrypt-failure retry model added).
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
//
// RETRY MODEL: this function folds into the receive drain's three-way model. A
// TRANSIENT failure is signalled by THROWING (the drain holds the cursor and
// retries this seq, giving up only at MAX_INTENT_RETRIES); a TERMINAL outcome is
// signalled by RETURNING (the drain advances past the row). The key distinction
// for decrypt failures is the CAUSE:
//   - key NOT available (the vault key slot is empty / not set up yet) -> THROW
//     (transient): hold + retry, so the row is not lost while setup is pending;
//     once the key exists the held row decrypts and processes. Persistent
//     absence gives up at the bound so it can't wedge the channel forever.
//   - decrypt failed WITH a key present (bad ciphertext / wrong shape / key
//     mismatch) -> RETURN (terminal): advance past the bad row and log.

import {
  parseEncryptedEnvelope,
  deriveEnvelopeKey,
  NoKeyError,
  WrongKeyError,
  NotEncryptedError,
  MalformedEnvelopeError,
} from '@glance-apps/intents'
import type { Envelope, IntentEventRow } from '@glance-apps/intents'

// Thrown when no decryption key is cached yet (encryption not set up on this
// device). The receive drain treats a throw as TRANSIENT, so the row is held and
// retried via the existing per-seq bounded-retry counter rather than skipped.
export class KeyNotAvailableError extends Error {
  constructor(eventId: string) {
    super(`encrypted intent ${eventId} received but intents encryption is not set up on this device yet`)
    this.name = 'KeyNotAvailableError'
  }
}

type ActivityEntry = { type: 'sent' | 'received' | 'warning' | 'error'; message: string; detail?: string }

export interface RouteIncomingDeps {
  // Loads the root key used to decrypt vault rows.
  loadRootKey: () => Promise<CryptoKey | null>
  // Handles a successfully-decrypted envelope (logging the completion, etc.).
  handleEnvelope: (envelope: Envelope) => Promise<void>
  addActivityEntry: (entry: ActivityEntry) => void
}

// Returned for tests/diagnostics on a TERMINAL outcome — the caller advances the
// cursor past the row. (A TRANSIENT failure throws instead of returning, so the
// drain holds the cursor and retries.)
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
    // KEY NOT AVAILABLE — TRANSIENT. Throw so the drain holds the cursor and
    // retries this seq (bounded by MAX_INTENT_RETRIES) instead of skipping past
    // it. This is what lets an intent received before encryption setup decrypt
    // and process once the key is in place, rather than being lost. No
    // per-attempt activity entry: the drain's onGiveUp logs loudly if the key
    // never arrives within the bound.
    throw new KeyNotAvailableError(row.eventId)
  }

  let envelope: Envelope
  try {
    envelope = await parseEncryptedEnvelope(data, (salt) => deriveEnvelopeKey(rootKey, salt))
  } catch (err) {
    // Key WAS present but decryption still failed — a genuinely bad row (wrong
    // shape / ciphertext / key mismatch). TERMINAL: advance past it and log.
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
