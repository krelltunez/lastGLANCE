// GLANCEvault (DB transport) config for INTENTS.
//
// This is the per-user opt-in gate for sending and receiving intents over the
// GLANCEvault `intents` endpoints instead of WebDAV files. It is deliberately
// SEPARATE from:
//   - the WebDAV intents config (src/intents/config.ts), which remains the
//     default and is fully intact — an app may run either transport; and
//   - the GLANCEvault *sync* enablement (src/sync/vaultConfig.ts), which moves
//     entity rows. Intents and sync are independent: enabling one does not
//     enable the other.
//
// The vault *connection* (url, device bearer token, account id) is shared with
// the sync transport and read from getVaultConfig() — intents reuse the same
// device-token auth. This module only owns the intents-specific enablement
// flag, the TTL/poll cadence, and the app-owned RECEIVE CURSOR.

import { parseSince, formatSince } from '@glance-apps/intents'
import { getVaultConfig } from '@/sync/vaultConfig'

const DB_INTENTS_CONFIG_KEY = 'lg_db_intents_config'

// The receive cursor lives in its OWN dedicated key, mirroring how the WebDAV
// intents cursor (lg_intents_cursor) is stored. The send path NEVER touches it
// (see dbTransport.sendCreateIntent): sending cannot advance what a device has
// received. This is the critical separation from the GLANCEvault sync cursor.
const DB_INTENTS_RECEIVE_CURSOR_KEY = 'lg_db_intents_receive_cursor'

export interface DbIntentsConfig {
  enabled: boolean
  // TTL applied to each outgoing intent row. The server returns only non-expired
  // rows, so this bounds how long a never-seen intent stays deliverable.
  ttlMs: number
  pollIntervalMinutes: number
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export const DEFAULT_DB_INTENTS_CONFIG: DbIntentsConfig = {
  enabled: false,
  ttlMs: THIRTY_DAYS_MS,
  pollIntervalMinutes: 15,
}

export function getDbIntentsConfig(): DbIntentsConfig {
  try {
    const raw = localStorage.getItem(DB_INTENTS_CONFIG_KEY)
    if (!raw) return { ...DEFAULT_DB_INTENTS_CONFIG }
    return { ...DEFAULT_DB_INTENTS_CONFIG, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_DB_INTENTS_CONFIG }
  }
}

export function saveDbIntentsConfig(config: DbIntentsConfig): void {
  localStorage.setItem(DB_INTENTS_CONFIG_KEY, JSON.stringify(config))
}

// True only when the DB intents transport is turned on AND the shared vault
// connection is fully populated (the same fields isVaultEnabled() requires).
// This is the single gate every send/receive path checks; when false the app
// behaves exactly as before and only the WebDAV intents transport runs.
export function isDbIntentsEnabled(): boolean {
  const cfg = getDbIntentsConfig()
  if (!cfg.enabled) return false
  const vault = getVaultConfig()
  return !!(vault && vault.vaultUrl && vault.vaultToken && vault.accountId)
}

// --- Receive cursor (app-owned) ---------------------------------------------
// Stored as the codec's `since` string form. parseSince/formatSince are the
// codec helpers; null/absent means "from the beginning" (full backlog).

export function getReceiveCursor(): number | null {
  return parseSince(localStorage.getItem(DB_INTENTS_RECEIVE_CURSOR_KEY))
}

export function setReceiveCursor(seq: number | null): void {
  localStorage.setItem(DB_INTENTS_RECEIVE_CURSOR_KEY, formatSince(seq))
}
