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
