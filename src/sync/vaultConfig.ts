// GLANCEvault (DB transport) connection config.
//
// This lives entirely separate from the file-tier WebDAV config (which is
// stored under SYNC_FOLDER_KEY and managed by the file engine). The vault
// transport is additive and reversible: when this config is absent or its
// `enabled` flag is false, the app behaves exactly as before and only the file
// engine runs. Clearing it reverts to the file tier instantly.

const VAULT_CONFIG_KEY = 'lastglance-vault-config'

export interface VaultConfig {
  enabled: boolean
  vaultUrl: string    // e.g. https://vault.glance-apps.com
  vaultToken: string  // device bearer token
  accountId: string   // household account id
  // Set only on a GLANCEvault Pro connection (the hosted vault). The engines
  // read a Pro connection exactly like a self-hosted one; only the settings
  // form shows it differently.
  pro?: boolean
}

// Reads the saved vault config, or null when none has been stored.
export function getVaultConfig(): VaultConfig | null {
  try {
    const raw = localStorage.getItem(VAULT_CONFIG_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<VaultConfig>
    return {
      enabled: !!parsed.enabled,
      vaultUrl: parsed.vaultUrl ?? '',
      vaultToken: parsed.vaultToken ?? '',
      accountId: parsed.accountId ?? '',
      ...(parsed.pro ? { pro: true } : {}),
    }
  } catch {
    return null
  }
}

// Persists the vault config, or clears it when passed null.
export function setVaultConfig(config: VaultConfig | null): void {
  if (config) localStorage.setItem(VAULT_CONFIG_KEY, JSON.stringify(config))
  else localStorage.removeItem(VAULT_CONFIG_KEY)
}

// True only when the vault transport is fully configured and turned on.
export function isVaultEnabled(): boolean {
  const c = getVaultConfig()
  return !!(c && c.enabled && c.vaultUrl && c.vaultToken && c.accountId)
}

// GLANCEvault Pro: the hosted vault. The person pastes one account key and the
// app enrolls this device with it (src/sync/vaultPro.ts), so the URL is fixed.
export const PRO_VAULT_URL = 'https://sync.glancevault.com'

// True when the stored config is a complete GLANCEvault Pro connection.
export function isProConnection(c: VaultConfig | null | undefined): boolean {
  return !!(c && c.pro && c.vaultUrl && c.vaultToken && c.accountId)
}

// The sync 1.10 credential halt persists under the engine's storage prefix and
// is cleared by the package only via per-account recovery, which shared-token
// mode never runs (issue #257). This is the wrapper-level exit: called from
// SyncSettingsModal's save when the vault credentials were actually edited, it
// grants exactly one fresh attempt — a still-rejected credential re-halts on
// the first cycle, so a user re-saving a bad token can never turn this into a
// retry storm. Cursors are untouched.
export function clearCredentialHalt(): void {
  try { localStorage.removeItem('lastglance-db-sync-credential-halt') } catch { /* storage unavailable */ }
}

// Every piece of persisted vault-sync state that belongs to one account's data
// stream. Key names must match @glance-apps/sync dbEngine.js's
// `${storageKeyPrefix}-...` keys for storageKeyPrefix 'lastglance', plus the
// wrapper's one-shot seed flag (dbEngine.ts SNAPSHOT_SEEDED_FLAG). Two device-
// scoped keys deliberately survive a reset: 'lastglance-device-id' (identifies
// the device, not the stream) and 'lastglance-db-sync-hwm-recovery-gen' (a
// completed one-time migration marker; the reset clears the HWM anyway, so
// re-running that recovery would be redundant, not corrective).
const STREAM_STATE_KEYS = [
  'lastglance-db-sync-snapshot-seeded', // wrapper's one-shot full-snapshot seed
  'lastglance-db-sync-config',          // engine's saved identity record
  'lastglance-db-sync-hwm',             // pull cursor
  'lastglance-db-sync-push-ack',        // push idempotency marker
  'lastglance-db-sync-dirty',           // persisted dirty set
  'lastglance-db-sync-quarantine',      // undecryptable-row retry set (seq-based)
  'lastglance-db-sync-last-synced',     // display timestamp
  'lastglance-db-sync-credential-halt', // sync 1.10 hard halt
]

// Reset all per-stream vault sync state. Cursors from one account must never
// be applied to another: a stale pull cursor would suppress the new account's
// low-seq rows, and the one-shot seed flag would keep this device's existing
// local data from ever uploading (the lastGLANCE twin of lifeGLANCE #286).
// Called from SyncSettingsModal's save on an IDENTITY change (different
// accountId or vaultUrl) and on UNLINK — unlike lifeGLANCE, disabling the
// vault here drops the credentials entirely, so the next link has no previous
// identity to compare against and must start from clean state. A token-only
// rotation keeps the identity and therefore the cursors. After a reset, the
// next cycle re-seeds: HWM=0 pulls everything the account has, and the
// snapshot seed marks all local entities dirty for the full push.
export function resetVaultSyncState(): void {
  for (const key of STREAM_STATE_KEYS) {
    try { localStorage.removeItem(key) } catch { /* storage unavailable — nothing to clear */ }
  }
}

// True when two vault configs point at DIFFERENT data streams (server or
// account changed). Token differences are deliberately ignored: a rotated
// token is the same stream. Null on either side is not an identity change —
// fresh links start clean via the unlink reset, and unlink itself is handled
// separately in saveConfig.
export function vaultIdentityChanged(
  prev: Pick<VaultConfig, 'vaultUrl' | 'accountId'> | null | undefined,
  next: Pick<VaultConfig, 'vaultUrl' | 'accountId'> | null | undefined,
): boolean {
  if (!prev || !next) return false
  return prev.vaultUrl.trim() !== next.vaultUrl.trim() ||
    prev.accountId.trim() !== next.accountId.trim()
}
