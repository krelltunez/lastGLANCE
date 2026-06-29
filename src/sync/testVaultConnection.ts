// Pre-save GLANCEvault credential verification.
//
// Runs an authenticated probe against the vault BEFORE the credentials are saved
// / activated, so a bad URL / token / account is caught in the settings UI
// instead of failing silently at the first sync cycle. The probe is the same
// GET /salt/:accountId call the intents key setup already uses
// (setupVaultIntentsEncryption.ts): createVaultClient(...).getSalt(accountId).
//
// It is native-safe by construction: it builds the client with the SAME
// (url, init) => Response adapter over nativeHttpFetch that the intents setup
// injects, so on the Capacitor shell the request goes through CapacitorHttp
// (CORS-free) and on web it falls back to the global fetch (the vault serves
// CORS). It never uses a plain global fetch directly.
//
// Nothing here saves, activates, derives a key, or registers a salt — it is a
// read-only reachability + auth check. In particular a fresh account that has no
// salt yet (getSalt -> null / 404) is an ACCEPTABLE outcome, NOT a failure: the
// salt is established on the first sync, and flagging it as an error would block
// first-device setup.

import { createVaultClient } from '@glance-apps/sync'
import type { SyncErrorCode } from '@glance-apps/sync'
import { isNativePlatform, nativeHttpFetch } from '@/sync/nativeHttp'

export interface VaultTestInput {
  vaultUrl: string
  vaultToken: string
  accountId: string
}

// Typed, mutually-exclusive outcomes. `code` reuses @glance-apps/sync's
// SyncErrorCode vocabulary so the UI classifies the same way the sync engine
// would. The two `ok: true` shapes are both "credentials are good":
//   - salt: true                  -> account already initialized.
//   - code: 'ACCOUNT_ID_REQUIRED' -> reachable + token/account accepted, but no
//                                    salt registered yet (fresh account). This is
//                                    the salt-not-established state, surfaced with
//                                    the existing typed code; it is NOT an error.
export type VaultTestOutcome =
  | { ok: true; code: null; salt: true }
  | { ok: true; code: Extract<SyncErrorCode, 'ACCOUNT_ID_REQUIRED'>; salt: false }
  | { ok: false; code: Extract<SyncErrorCode, 'AUTH_FAILURE' | 'FORBIDDEN' | 'NETWORK_ERROR'> }

// Native-safe (url, init) => Response adapter over nativeHttpFetch. Identical to
// the intents setup path's private vaultFetchImpl: undefined on web so
// createVaultClient uses the global fetch (vault serves CORS); on native it
// routes through CapacitorHttp and presents the { ok, status, json, text } subset
// the vault client reads.
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

// Maps a thrown getSalt error to a typed failure outcome. The vault client's
// jsonOrThrow raises a VaultError carrying `.status` (the HTTP status) on a
// non-2xx response; a network failure / bad URL / aborted request rejects with a
// plain error that has no `.status`. Pure and exported so each branch is unit
// testable without a server.
export function classifyVaultTestError(err: unknown): VaultTestOutcome {
  const status = (err as { status?: unknown })?.status
  if (status === 401) return { ok: false, code: 'AUTH_FAILURE' }
  if (status === 403) return { ok: false, code: 'FORBIDDEN' }
  // Anything else — no status (network / DNS / bad URL / timeout) or any other
  // non-2xx (e.g. 5xx) — is reported as "couldn't reach/use the vault here".
  return { ok: false, code: 'NETWORK_ERROR' }
}

// Default salt fetcher: the real vault client, wired with the native-safe fetch.
function defaultGetSalt(input: VaultTestInput): (accountId: string) => Promise<Uint8Array | null> {
  const client = createVaultClient({
    vaultUrl: input.vaultUrl,
    vaultToken: input.vaultToken,
    fetchImpl: vaultFetchImpl(),
  })
  return (accountId: string) => client.getSalt(accountId)
}

// Verifies the entered credentials by fetching the account salt. Never throws —
// every path resolves to a typed VaultTestOutcome. `getSaltImpl` is injectable so
// tests can drive each outcome without a live vault; production uses the real
// client built by defaultGetSalt.
export async function testVaultConnection(
  input: VaultTestInput,
  getSaltImpl: (accountId: string) => Promise<Uint8Array | null> = defaultGetSalt(input),
): Promise<VaultTestOutcome> {
  try {
    const salt = await getSaltImpl(input.accountId)
    // A non-empty salt means the account is initialized -> fully good.
    if (salt && salt.length > 0) return { ok: true, code: null, salt: true }
    // null (404) or empty -> no salt registered yet: fresh account, acceptable.
    return { ok: true, code: 'ACCOUNT_ID_REQUIRED', salt: false }
  } catch (err) {
    return classifyVaultTestError(err)
  }
}
