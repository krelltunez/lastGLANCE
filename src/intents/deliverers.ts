// Intents DELIVERERS (stage 2a).
//
// A deliverer is what the outbox's flush() calls per transport: it takes the RAW
// intent the outbox persisted, builds + encrypts the envelope AT FLUSH TIME, and
// sends it. It returns one of the outbox's DeliveryResult values:
//   'delivered'      — sent (insert-only/idempotent on event_id, so re-send safe).
//   'transient-fail' — try again later (held in the outbox, never dropped).
//   'permanent-fail' — give up on this transport for this intent.
// A deliverer must NEVER throw for an expected failure; it classifies instead.
// (An unexpected throw is still safe — the outbox treats it as transient.)
//
// SCOPE (2a): the vault deliverer only LOADS an already-cached vault intents key.
// Deriving/caching that key (and any passphrase prompt) is stage 2b. Until the
// key exists, the vault deliverer returns 'transient-fail' and builds/sends
// nothing — so an intent is held, never lost and never sent as plaintext.

import {
  ACTIONS,
  buildEnvelope,
  buildEncryptedEnvelope,
  buildIntentRow,
  deriveEnvelopeKey,
} from '@glance-apps/intents'
import type { CreatePayload, IntentEnvelope, OutboundIntentRow } from '@glance-apps/intents'
import { INTENTS_KEY_NOT_READY } from './outbox'
import type { Deliverer, DeliveryResult, OutboxIntent } from './outbox'
import { getConn, vaultFetch, type VaultConn } from './dbTransport'
import { getDbIntentsConfig } from './dbConfig'
import { getIntentsConfig, isIntentsConfigured, type IntentsConfig } from './config'
import { loadVaultIntentsRootKey } from './vaultIntentsKeyStore'
import { loadIntentsRootKey } from './intentsKeyStore'
import { buildAuthHeader, ensureFolder, putFile } from './webdav'

// Maps the raw outbox intent onto the codec's CREATE envelope args. Passing
// eventId + emittedAt preserves the intent's stable identity across (re)builds,
// so a re-sent intent is byte-stable and idempotent on the server. CREATE is the
// only action lastGLANCE emits today, mirroring the existing buildCreateEnvelope.
function createEnvelopeArgs(intent: OutboxIntent) {
  return {
    action: ACTIONS.CREATE,
    payload: intent.payload as CreatePayload,
    emittedBy: intent.emitted_by,
    eventId: intent.event_id,
    ...(intent.emitted_at ? { emittedAt: new Date(intent.emitted_at) } : {}),
  }
}

// Extracts an HTTP status from a thrown transport error whose message embeds one
// (webdav.ts/putFile throws `... failed: <status> <text>`). Returns null when the
// error carries no status (e.g. a network/timeout error) — those are transient.
function statusFromError(err: unknown): number | null {
  const m = (err instanceof Error ? err.message : String(err)).match(/failed:\s*(\d{3})/)
  return m ? Number(m[1]) : null
}

// Shared status -> outcome mapping. 2xx is handled by the caller; here we map a
// non-2xx response: 5xx and the "retry" 4xx codes (408/429) are transient; any
// other 4xx is a permanent (client/misconfig) failure; anything else retries.
function classifyStatus(status: number): DeliveryResult {
  if (status >= 500) return 'transient-fail'
  if (status === 408 || status === 429) return 'transient-fail'
  if (status >= 400) return 'permanent-fail'
  return 'transient-fail'
}

// ── Vault deliverer (ALWAYS ENCRYPTED) ───────────────────────────────────────

export interface VaultDelivererDeps {
  // Loads the cached VAULT intents root key (distinct slot from WebDAV). null ->
  // not set up yet on this device.
  loadRootKey: () => Promise<CryptoKey | null>
  // TTL applied to the outgoing row.
  ttlMs: () => number
  // POSTs the batch over the shared GLANCEvault connection. Resolves to the
  // response (ok/status), or null when there is no vault connection configured.
  send: (events: OutboundIntentRow[]) => Promise<{ ok: boolean; status: number } | null>
}

// The default send wires the exact connection + fetch path the DB transport's
// receive/send drains use (device-token bearer, native vs browser).
async function realVaultSend(
  events: OutboundIntentRow[],
): Promise<{ ok: boolean; status: number } | null> {
  const conn: VaultConn | null = getConn()
  if (!conn) return null
  return vaultFetch(conn, 'POST', '/intents/batch', {
    body: { accountId: conn.accountId, events },
  })
}

export function createVaultDeliverer(deps: VaultDelivererDeps): Deliverer {
  return async (intent: OutboxIntent): Promise<DeliveryResult> => {
    // KEY USAGE (for cross-app comparison vs dayGLANCE): load the cached vault
    // root key, then encrypt each envelope under a per-envelope key derived as
    // deriveEnvelopeKey(rootKey, salt). This is the ONLY key path for the vault —
    // there is no plaintext branch.
    const rootKey = await deps.loadRootKey()
    if (!rootKey) {
      // Key not set up yet (2b populates it): hold the intent, build/send NOTHING.
      // Tag the hold so flush/the Activity Log can show "waiting for key" instead
      // of an indistinguishable silent stall — the row is still held + retried.
      return { status: 'transient-fail', reason: INTENTS_KEY_NOT_READY }
    }

    const envelope: IntentEnvelope = await buildEncryptedEnvelope(
      createEnvelopeArgs(intent),
      (salt) => deriveEnvelopeKey(rootKey, salt),
    )
    const row = buildIntentRow(envelope, { ttlMs: deps.ttlMs() })

    let res: { ok: boolean; status: number } | null
    try {
      res = await deps.send([row])
    } catch {
      // Network/timeout/abort: hold and retry.
      return 'transient-fail'
    }
    if (res === null) return 'transient-fail' // no vault connection yet
    if (res.ok) return 'delivered'
    return classifyStatus(res.status)
  }
}

// Default vault deliverer: always-encrypted, reads the cached vault key slot.
export const vaultDeliverer: Deliverer = createVaultDeliverer({
  loadRootKey: loadVaultIntentsRootKey,
  ttlMs: () => getDbIntentsConfig().ttlMs,
  send: realVaultSend,
})

// ── WebDAV deliverer (existing encryption POLICY, unchanged) ──────────────────
// WebDAV keeps its current behavior: encrypt when the WebDAV intents encryption
// toggle is on, otherwise send a plaintext envelope. Only the vault is forced to
// always-encrypt; the WebDAV policy is intentionally left as-is here.

export interface WebdavDelivererDeps {
  getConfig: () => IntentsConfig
  isConfigured: (config: IntentsConfig) => boolean
  // Loads the cached WEBDAV intents root key (used only when encryption is on).
  loadRootKey: () => Promise<CryptoKey | null>
  // PUTs the event file; resolves on success, throws on failure (status embedded
  // in the message for non-network errors), mirroring webdav.ts/putFile.
  put: (config: IntentsConfig, filename: string, content: string) => Promise<void>
}

async function realWebdavPut(config: IntentsConfig, filename: string, content: string): Promise<void> {
  const authHeader = buildAuthHeader(config.webdavUsername, config.webdavPassword)
  await ensureFolder(config.webdavUrl, config.folderPath, authHeader)
  await putFile(config.webdavUrl, config.folderPath, filename, content, authHeader)
}

export function createWebdavDeliverer(deps: WebdavDelivererDeps): Deliverer {
  return async (intent: OutboxIntent): Promise<DeliveryResult> => {
    const config = deps.getConfig()
    // Not set up yet: hold rather than give up (a webdav target should only have
    // been enqueued when configured; if config is briefly absent, retry).
    if (!deps.isConfigured(config)) return 'transient-fail'

    let envelope: IntentEnvelope
    if (config.encryptionEnabled) {
      const rootKey = await deps.loadRootKey()
      // Encryption is on but the WebDAV key isn't ready: hold, don't downgrade to
      // plaintext, don't give up.
      if (!rootKey) return 'transient-fail'
      envelope = await buildEncryptedEnvelope(
        createEnvelopeArgs(intent),
        (salt) => deriveEnvelopeKey(rootKey, salt),
      )
    } else {
      // Existing WebDAV policy: plaintext envelope when encryption is off.
      envelope = buildEnvelope(createEnvelopeArgs(intent))
    }

    const filename = `${envelope.event_id}.json`
    const content = JSON.stringify(envelope)

    try {
      await deps.put(config, filename, content)
      return 'delivered'
    } catch (err) {
      const status = statusFromError(err)
      if (status === null) return 'transient-fail' // network/timeout
      return classifyStatus(status)
    }
  }
}

// Default WebDAV deliverer.
export const webdavDeliverer: Deliverer = createWebdavDeliverer({
  getConfig: getIntentsConfig,
  isConfigured: isIntentsConfigured,
  loadRootKey: loadIntentsRootKey,
  put: realWebdavPut,
})
