// GLANCEvault Pro: connect this device to the hosted vault with one account key.
//
// The person pastes the account key they were sent. The app exchanges it for
// this device's own credential (POST /enroll on a server running
// GLANCEVAULT_ENROLLMENT_MODE=account-key, glance-vault #37) and stores the
// result as an ordinary vault connection flagged `pro`, so the sync engines,
// the event stream, intents and the headless refresh read it exactly like a
// self-hosted one. The key is sent once, in the body, and never stored:
// re-enrolling with it later mints a fresh credential and retires the old one.
//
// Connecting turns on GLANCEvault sync AND GLANCEvault intents. Multi-user and
// People-on-the-vault stay the person's own choices and are not touched. The
// sync passphrase is still required (end-to-end encryption): after the reload
// the app asks for it, as it does for any new vault connection.

import { clearDbRootKey } from '@glance-apps/sync'
import { isNativePlatform, nativeHttpFetch } from './nativeHttp'
import { getDeviceId } from './deviceId'
import { DB_CRYPTO_CONFIG } from './engine'
import {
  PRO_VAULT_URL,
  clearCredentialHalt,
  getVaultConfig,
  resetVaultSyncState,
  setVaultConfig,
  vaultIdentityChanged,
  type VaultConfig,
} from './vaultConfig'
import { getDbIntentsConfig, saveDbIntentsConfig } from '@/intents/dbConfig'
import { clearVaultIntentsRootKey } from '@/intents/vaultIntentsKeyStore'

export type VaultProEnrollErrorCode =
  | 'KEY_REJECTED'  // the server does not recognise the key (401/403), or none was entered
  | 'UNAVAILABLE'   // no response, or the server is not offering enrollment (404)
  | 'SERVER_ERROR'  // any other non-success status, or a malformed reply

export class VaultProEnrollError extends Error {
  readonly code: VaultProEnrollErrorCode
  readonly status?: number
  constructor(code: VaultProEnrollErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'VaultProEnrollError'
    this.code = code
    this.status = status
  }
}

// One POST. Native goes through CapacitorHttp (CORS-free) like every other
// vault call; the browser/PWA uses fetch, which needs the page's origin in the
// server's GLANCEVAULT_ALLOWED_ORIGINS.
export type EnrollPost = (url: string, body: string) => Promise<{ status: number; body: string }>

const ENROLL_TIMEOUT_MS = 20_000

const defaultPost: EnrollPost = async (url, body) => {
  const headers = { 'Content-Type': 'application/json' }
  if (isNativePlatform) {
    const r = await nativeHttpFetch('POST', url, headers, body)
    return { status: r.status, body: r.body }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ENROLL_TIMEOUT_MS)
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal })
    return { status: res.status, body: await res.text() }
  } finally {
    clearTimeout(timer)
  }
}

export interface EnrollOptions {
  post?: EnrollPost
  vaultUrl?: string
  deviceId?: string
}

// Exchanges the account key for this device's credential and the account it
// belongs to. Throws VaultProEnrollError; never stores anything.
export async function enrollWithAccountKey(
  accountKey: string,
  opts: EnrollOptions = {},
): Promise<{ credential: string; accountId: string }> {
  const key = (accountKey || '').trim()
  if (!key) throw new VaultProEnrollError('KEY_REJECTED', 'No account key entered.')
  const post = opts.post ?? defaultPost
  const base = (opts.vaultUrl ?? PRO_VAULT_URL).replace(/\/+$/, '')
  const deviceId = opts.deviceId ?? getDeviceId()

  let res: { status: number; body: string }
  try {
    res = await post(`${base}/enroll`, JSON.stringify({ accountKey: key, deviceId }))
  } catch {
    throw new VaultProEnrollError('UNAVAILABLE', 'Could not reach GLANCEvault Pro.')
  }

  const { status } = res
  if (status === 401 || status === 403) {
    throw new VaultProEnrollError('KEY_REJECTED', 'The account key was not accepted.', status)
  }
  if (status === 404) {
    // /enroll is only registered on a per-account server.
    throw new VaultProEnrollError('UNAVAILABLE', 'This server does not offer enrollment.', status)
  }
  if (status !== 200 && status !== 201) {
    throw new VaultProEnrollError('SERVER_ERROR', `Enrollment failed (status ${status}).`, status)
  }

  let parsed: { credential?: unknown; accountId?: unknown } | null = null
  try { parsed = JSON.parse(res.body) } catch { parsed = null }
  const credential = parsed?.credential
  const accountId = parsed?.accountId
  if (typeof credential !== 'string' || !credential || typeof accountId !== 'string' || !accountId) {
    throw new VaultProEnrollError('SERVER_ERROR', 'Enrollment reply was missing the credential.', status)
  }
  return { credential, accountId }
}

export interface ConnectDeps extends EnrollOptions {
  // Drops the cached vault keys (sync root key and intents key). Both derive
  // from the account's salt, so a key cached for another account would encrypt
  // this one's rows with the wrong key. Injected for tests.
  clearVaultKeys?: () => Promise<void>
}

async function defaultClearVaultKeys(): Promise<void> {
  await clearDbRootKey(DB_CRYPTO_CONFIG).catch(() => { /* nothing cached */ })
  await clearVaultIntentsRootKey().catch(() => { /* nothing cached */ })
}

/**
 * Enrolls with the account key, then stores the Pro connection and turns on
 * GLANCEvault sync and intents. On failure nothing is stored. The caller
 * reloads afterwards so the engines reconstruct.
 *
 * Stream hygiene follows the self-hosted save: a different account (or no
 * previous connection) starts clean, cursors and cached keys both; enrolling
 * again into the same account only rotates the credential, so the cursors and
 * keys stay and only a standing credential halt is cleared.
 */
export async function connectVaultPro(accountKey: string, deps: ConnectDeps = {}): Promise<VaultConfig> {
  const enrolled = await enrollWithAccountKey(accountKey, deps)
  const prev = getVaultConfig()
  const next: VaultConfig = {
    enabled: true,
    vaultUrl: deps.vaultUrl ?? PRO_VAULT_URL,
    vaultToken: enrolled.credential,
    accountId: enrolled.accountId,
    pro: true,
  }
  const sameStream = !!prev && !!prev.vaultToken && !vaultIdentityChanged(prev, next)

  setVaultConfig(next)
  saveDbIntentsConfig({ ...getDbIntentsConfig(), enabled: true })

  if (sameStream) {
    clearCredentialHalt()
  } else {
    resetVaultSyncState()
    await (deps.clearVaultKeys ?? defaultClearVaultKeys)()
  }
  return next
}
