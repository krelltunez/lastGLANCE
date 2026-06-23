// Vault intents encryption setup (stage 2b-i).
//
// Parallels src/intents/setupIntentsEncryption.ts (the WebDAV path), but sources
// the salt from the GLANCEvault server instead of a WebDAV file, and caches the
// derived key in the VAULT key slot (distinct from the WebDAV slot). The
// derivation is byte-identical to the WebDAV path — deriveIntentsRootKey(
// passphrase, salt) — so any GLANCE app deriving from the SAME sync passphrase
// and the SAME vault salt obtains the IDENTICAL key (required for cross-app
// decryptability). Only the salt SOURCE differs.

import { deriveIntentsRootKey } from '@glance-apps/intents'
import { createVaultClient } from '@glance-apps/sync'
import { getConn } from './dbTransport'
import { isNativePlatform, nativeHttpFetch } from '@/sync/nativeHttp'
import { storeVaultIntentsRootKey } from './vaultIntentsKeyStore'

// Thrown when the GLANCEvault connection is not configured (no url/token/account).
export class VaultConnMissingError extends Error {
  constructor() {
    super('GLANCEvault connection not configured')
    this.name = 'VaultConnMissingError'
  }
}

// Thrown when the server has no salt registered for this account. We do NOT
// invent a salt here: a missing salt means the account's root-key salt has not
// been established yet (normally the vault SYNC transport registers it on first
// sync), and deriving against a fabricated salt would produce a key no other
// device could reproduce.
export class VaultSaltMissingError extends Error {
  constructor() {
    super('GLANCEvault has no encryption salt registered for this account yet')
    this.name = 'VaultSaltMissingError'
  }
}

// Native-safe fetch adapter, mirroring the path the DB transport uses: on the
// native shell, route through CapacitorHttp (CORS-free); in the browser/PWA,
// return undefined so createVaultClient falls back to the global fetch (the
// vault server serves CORS). Typed as `typeof fetch`; only the subset
// createVaultClient calls (ok/status/json) is exercised.
function vaultFetchImpl(): typeof fetch | undefined {
  if (!isNativePlatform) return undefined
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const r = await nativeHttpFetch(
      init?.method ?? 'GET',
      url,
      (init?.headers as Record<string, string>) ?? {},
      (init?.body as string) ?? null,
    )
    return {
      ok: r.ok,
      status: r.status,
      json: async () => JSON.parse(r.body),
      text: async () => r.body,
    } as Response
  }) as typeof fetch
}

// Derives and caches the vault intents root key from the sync passphrase + the
// GLANCEvault account salt. Throws VaultConnMissingError / VaultSaltMissingError
// (or a network error) without caching anything on failure — the caller must not
// enable vault intents unless this resolves.
export async function setupVaultIntentsEncryption(passphrase: string): Promise<void> {
  const conn = getConn()
  if (!conn) throw new VaultConnMissingError()

  const client = createVaultClient({
    vaultUrl: conn.vaultUrl,
    vaultToken: conn.vaultToken,
    fetchImpl: vaultFetchImpl(),
  })

  const salt = await client.getSalt(conn.accountId)
  if (!salt) throw new VaultSaltMissingError()

  // EXACT same derivation as the WebDAV intents path, only the salt source
  // differs (vault /salt/:accountId instead of the WebDAV salt file).
  const rootKey = await deriveIntentsRootKey(passphrase, new Uint8Array(salt))
  await storeVaultIntentsRootKey(rootKey)
}

// ── Enable-time orchestration ────────────────────────────────────────────────
// The decision logic the "Enable GLANCEvault intents" save handler runs before
// it saves + reloads. Extracted (with injected deps) so it is unit-testable
// without mounting the modal. Returns:
//   'ready'     — a key is cached (already, or freshly derived) -> safe to enable.
//   'cancelled' — the user dismissed the passphrase prompt -> do NOT enable.
//   'error'     — derivation failed (missing salt/connection/network) -> do NOT
//                 enable; `error` carries the cause for messaging.
export interface EnsureVaultKeyDeps {
  loadCachedKey: () => Promise<CryptoKey | null>
  getPassphrase: () => string | null
  promptForPassphrase: () => Promise<string | null>
  derive: (passphrase: string) => Promise<void>
}

export type EnsureVaultKeyResult =
  | { status: 'ready' }
  | { status: 'cancelled' }
  | { status: 'error'; error: unknown }

export async function ensureVaultIntentsKey(deps: EnsureVaultKeyDeps): Promise<EnsureVaultKeyResult> {
  // 1. Already cached -> nothing to do.
  if (await deps.loadCachedKey()) return { status: 'ready' }

  // 2. Passphrase availability is DISTINCT from connection presence.
  let passphrase = deps.getPassphrase()
  if (!passphrase) {
    passphrase = await deps.promptForPassphrase()
    if (!passphrase) return { status: 'cancelled' } // never enable without a key
  }

  // 3 & 4. Fetch salt + derive + cache (deps.derive == setupVaultIntentsEncryption).
  try {
    await deps.derive(passphrase)
    return { status: 'ready' }
  } catch (error) {
    return { status: 'error', error }
  }
}
