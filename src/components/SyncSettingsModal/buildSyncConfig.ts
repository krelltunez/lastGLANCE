// Decides what WebDAV sync config to persist when the settings modal saves.
//
// Extracted from SyncSettingsModal so it can be unit-tested. The important
// invariant (issue #204): turning sync OFF — or saving while some connection
// field is blank — must NOT discard the config. The old code passed `null` to
// setConfig whenever the required fields weren't all filled, which deleted the
// config (wiping credentials) and made the enabled toggle spring back to its
// default (on) the next time the modal opened, i.e. "WebDAV re-enables itself".
//
// Rule now: keep the config whenever the user has entered *anything* for the
// active provider, persisting `enabled` as chosen. Only clear the config (null)
// when every field for the active provider is empty — a genuinely blank setup.

export interface SyncConfigField {
  key: string
}

export interface BuildSyncConfigInput {
  provider: string
  formData: Record<string, string>
  configFields: readonly SyncConfigField[]
  folderPath: string
  syncEnabled: boolean
  encEnabled: boolean
}

export function buildSyncConfigToSave(
  input: BuildSyncConfigInput,
): Record<string, unknown> | null {
  const hasAnyField = input.configFields.some(
    (f) => (input.formData[f.key] ?? '').trim() !== '',
  )
  if (!hasAnyField) return null
  return {
    provider: input.provider,
    ...input.formData,
    syncFolder: input.folderPath,
    enabled: input.syncEnabled,
    encryptionEnabled: input.encEnabled,
  }
}
