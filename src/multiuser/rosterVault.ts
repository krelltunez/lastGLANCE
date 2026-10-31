// The household roster on GLANCEvault: the glance-users app, which every GLANCE
// app (dayGLANCE, lastGLANCE, lifeGLANCE) reads and writes, so a member added
// in one app reaches the others on an account that syncs through the vault
// alone. glance-users.json on WebDAV or in a Direct Access folder is the same
// roster over the file roads (src/multiuser/sharedUsers.ts).
//
// The wire contract, shared with the sibling apps:
//   app       glance-users
//   entityId  the member's sync id
//   entity    { id: sync id, name, updatedAt: ISO string }  (glance-users.json's
//             SharedUser shape, without `deleted`)
//   delete    the engine's soft-delete; nothing else marks a member gone.
// Entities are encrypted under the account's root key, which every app on the
// account already shares (the salt is per account), so nothing new is set up.
//
// A vault server that predates glance-users answers 400 "unknown app": the
// engine stands down for the session and the roster keeps to the file roads.

import { createDbSyncEngine } from '@glance-apps/sync'
import type { DbSyncEngine, DbSyncResult, SyncErrorCode, SyncStatus } from '@glance-apps/sync'
import { db } from '@/db/client'
import type { User } from '@/types'
import { getVaultConfig, isVaultEnabled } from '@/sync/vaultConfig'
import { getDeviceId } from '@/sync/deviceId'
import { DB_ROOT_KEY_HOOKS } from '@/sync/nativeKeyHooks'
import { headlessFetchImpl } from '@/headless/headlessHttp'
import { isUnknownAppError } from '@/people/sync/dbEngine'
import { getMultiUserEnabled } from './settings'

export const ROSTER_VAULT_APP = 'glance-users'
// Per-app local state (cursor, dirty set, seed flag); the vault app is shared.
const STORAGE_PREFIX = `lastglance-${ROSTER_VAULT_APP}`
const SEEDED_FLAG = `${STORAGE_PREFIX}-db-sync-snapshot-seeded`

// Set once a server has answered "unknown app" this session, so an explicit
// Sync now can tell a server without glance-users from a failed cycle.
let unsupportedThisSession = false
export function isRosterVaultUnsupported(): boolean { return unsupportedThisSession }

export function rosterDeviceId(): string {
  return `${getDeviceId()}-roster`
}

export interface RosterEntity {
  id: string
  name: string
  updatedAt: string
}

export function isRosterEntity(entity: unknown): entity is RosterEntity {
  if (!entity || typeof entity !== 'object') return false
  const e = entity as Record<string, unknown>
  return typeof e.id === 'string' && !!e.id && typeof e.name === 'string' && !!e.name.trim() && typeof e.updatedAt === 'string'
}

export const toRosterEntity = (u: User): RosterEntity => ({ id: u.sync_id, name: u.name, updatedAt: u.updated_at })

export async function getLocalRosterEntity(entityId: string): Promise<RosterEntity | null> {
  const user = await db.users.where('sync_id').equals(entityId).first()
  return user ? toRosterEntity(user) : null
}

export function getRosterEntityLastModified(entity: unknown): string | undefined {
  return isRosterEntity(entity) ? entity.updatedAt : undefined
}

function notifyApplied(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('lg:sync-applied'))
}

// Upsert by sync id. A member this device deleted later than the remote edit
// stays deleted: the local tombstone is newer, and its soft-delete is on the
// way up.
export async function applyRemoteRosterEntity(entityId: string, entity: unknown): Promise<void> {
  if (!isRosterEntity(entity) || entity.id !== entityId) return
  const changed = await db.transaction('rw', db.users, db.tombstones, async () => {
    const tomb = await db.tombstones.get(entityId)
    const existing = await db.users.where('sync_id').equals(entityId).first()
    if (!existing && tomb && tomb.deleted_at >= entity.updatedAt) return false
    if (existing) {
      if (existing.updated_at >= entity.updatedAt) return false
      await db.users.update(existing.id, { name: entity.name, updated_at: entity.updatedAt })
      return true
    }
    if (tomb) await db.tombstones.delete(entityId)
    await db.users.add({ sync_id: entityId, name: entity.name, updated_at: entity.updatedAt } as User)
    return true
  })
  if (changed) notifyApplied()
}

export async function applyRemoteRosterDelete(entityId: string): Promise<void> {
  const changed = await db.transaction('rw', db.users, db.tombstones, async () => {
    await db.tombstones.put({ id: entityId, deleted_at: new Date().toISOString() })
    const user = await db.users.where('sync_id').equals(entityId).first()
    if (!user) return false
    await db.users.delete(user.id)
    return true
  })
  if (changed) notifyApplied()
}

export interface RosterDbEngineCallbacks {
  onStatusChange?: (status: SyncStatus) => void
  onError?: (message: string | null, code: SyncErrorCode | null) => void
  // The vault does not know glance-users yet; the roster stays on the file roads.
  onUnsupported?: () => void
}

const EMPTY_RESULT = { applied: 0, skipped: 0, skippedEntityIds: [] } as unknown as DbSyncResult

// Returns null when the vault is off. A cycle is a no-op while multi-user mode
// is off on this device: there is no household to share.
export function createRosterDbEngine(callbacks: RosterDbEngineCallbacks = {}): DbSyncEngine | null {
  if (!isVaultEnabled()) return null
  const cfg = getVaultConfig()!
  let unsupported = false

  const engine = createDbSyncEngine({
    storageKeyPrefix: STORAGE_PREFIX,
    appId: ROSTER_VAULT_APP,
    vaultApp: ROSTER_VAULT_APP,
    cryptoDBName: 'lastglance-crypto',
    ...DB_ROOT_KEY_HOOKS,
    vaultUrl: cfg.vaultUrl,
    vaultToken: cfg.vaultToken,
    fetchImpl: headlessFetchImpl(),
    accountId: cfg.accountId,
    deviceId: rosterDeviceId(),
    getLocalEntity: getLocalRosterEntity,
    applyRemoteEntity: applyRemoteRosterEntity,
    applyRemoteDelete: applyRemoteRosterDelete,
    isInsertOnly: () => false,
    getEntityLastModified: getRosterEntityLastModified,
    pullCursorCommit: 'per-page',
    onStatusChange: callbacks.onStatusChange,
    onError: (message, code) => {
      if (isUnknownAppError(message)) {
        if (!unsupported) {
          unsupported = true
          unsupportedThisSession = true
          callbacks.onUnsupported?.()
        }
        return
      }
      callbacks.onError?.(message, code)
    },
  })

  // First sync on this device: push the whole local roster once, then latch,
  // like the People engine's one-shot seed.
  const runCycle = engine.dbSyncCycle.bind(engine)
  const dbSyncCycle = async (): Promise<DbSyncResult> => {
    if (unsupported || !getMultiUserEnabled()) return EMPTY_RESULT
    if (localStorage.getItem(SEEDED_FLAG) !== '1') {
      if (engine.getHighWaterMark() > 0) {
        localStorage.setItem(SEEDED_FLAG, '1')
      } else {
        try {
          for (const u of await db.users.toArray()) engine.markDirty(u.sync_id)
          localStorage.setItem(SEEDED_FLAG, '1')
        } catch (err) {
          console.warn('[lastglance] roster vault initial snapshot failed:', err)
        }
      }
    }
    return runCycle()
  }

  return { ...engine, dbSyncCycle, sync: dbSyncCycle }
}
