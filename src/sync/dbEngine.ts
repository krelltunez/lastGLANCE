// GLANCEvault database transport wiring for lastGLANCE (Phase 4 cutover).
//
// This constructs the row-grained DB engine from @glance-apps/sync v1.2.0 and
// supplies the data callbacks that bridge it to the Dexie tables. It runs only
// when the vault config is enabled, and runs ALONGSIDE the file-tier engine,
// never replacing it. The file engine, its WebDAV payload, and its sync cycle
// are completely untouched by this module.
//
// The callbacks here read and write the same camelCase sync shapes that the
// file tier's buildPayload / applyPayload use, so a household can run either
// transport against the same local data. Crucially, applyRemoteEntity and
// applyRemoteDelete write to Dexie DIRECTLY (not through src/db/queries.ts), so
// remote applies never call markDirty and cannot loop back into a push.

import { createDbSyncEngine } from '@glance-apps/sync'
import type { DbSyncEngine, SyncStatus, SyncErrorCode } from '@glance-apps/sync'
import { db } from '@/db/client'
import type { Category, Chore, CompletionEvent, User } from '@/types'
import type { SyncCategory, SyncChore, SyncCompletionEvent, SyncUser } from './types'
import { getVaultConfig, isVaultEnabled } from './vaultConfig'
import { getDeviceId } from './deviceId'

const APP_ID = 'lastglance'
const CRYPTO_DB_NAME = 'lastglance-crypto'

// ── Entity-shape helpers (pure; safe to unit test without a DB) ──────────────

type EntityKind = 'category' | 'chore' | 'completionEvent' | 'user'

// Determine which entity a decrypted sync shape represents. Order matters:
// completion events and chores carry fields that uniquely identify them before
// the broader category / user checks.
function entityKind(entity: unknown): EntityKind | null {
  if (!entity || typeof entity !== 'object') return null
  const e = entity as Record<string, unknown>
  if ('completedAt' in e || 'choreSyncId' in e) return 'completionEvent'
  if ('categorySyncId' in e) return 'chore'
  if ('parentId' in e || 'sortOrder' in e) return 'category'
  if ('name' in e) return 'user'
  return null
}

// Insert-only types never conflict on merge: completion events are immutable.
export function isInsertOnly(entity: unknown): boolean {
  return entityKind(entity) === 'completionEvent'
}

// Timestamp the engine compares for entity-grain last-writer-wins: updatedAt
// for categories, chores, and users; completedAt for completion events.
export function getEntityLastModified(entity: unknown): string | number | undefined {
  if (!entity || typeof entity !== 'object') return undefined
  const e = entity as Record<string, unknown>
  if (entityKind(e) === 'completionEvent') return e.completedAt as string | undefined
  return e.updatedAt as string | undefined
}

// ── Row -> sync shape mappings (mirror the file tier's buildPayload) ─────────

function toSyncCategory(c: Category): SyncCategory {
  return {
    id: c.sync_id,
    name: c.name,
    sortOrder: c.sort_order,
    icon: c.icon,
    parentId: c.parent_sync_id,
    assignedUserSyncIds: c.assigned_user_sync_ids ?? [],
    updatedAt: c.updated_at,
  }
}

function toSyncChore(c: Chore): SyncChore {
  return {
    id: c.sync_id,
    name: c.name,
    categorySyncId: c.category_sync_id,
    sortOrder: c.sort_order,
    targetCadenceDays: c.target_cadence_days,
    notifyWhenOverdue: c.notify_when_overdue,
    autoScheduleToDayglance: c.auto_schedule_to_dayglance,
    preferredScheduleBehavior: c.preferred_schedule_behavior,
    seasonalStart: c.seasonal_start ?? null,
    seasonalEnd: c.seasonal_end ?? null,
    icon: c.icon,
    assignedUserSyncIds: c.assigned_user_sync_ids ?? [],
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  }
}

function toSyncCompletionEvent(e: CompletionEvent, choreSyncId: string): SyncCompletionEvent {
  return {
    id: e.sync_id,
    choreSyncId,
    completedAt: e.completed_at,
    note: e.note,
    source: e.source,
    completedByUserSyncId: e.completed_by_user_sync_id ?? null,
  }
}

function toSyncUser(u: User): SyncUser {
  return { id: u.sync_id, name: u.name, updatedAt: u.updated_at }
}

// ── getLocalEntity: look up by sync_id across all four tables ─────────────────

export async function getLocalEntity(entityId: string): Promise<unknown | null> {
  const cat = await db.categories.where('sync_id').equals(entityId).first()
  if (cat) return toSyncCategory(cat)

  const chore = await db.chores.where('sync_id').equals(entityId).first()
  if (chore) return toSyncChore(chore)

  const evt = await db.completionEvents.where('sync_id').equals(entityId).first()
  if (evt) {
    const parent = await db.chores.get(evt.chore_id)
    return toSyncCompletionEvent(evt, parent?.sync_id ?? '')
  }

  const user = await db.users.where('sync_id').equals(entityId).first()
  if (user) return toSyncUser(user)

  return null
}

// ── applyRemoteEntity: upsert a decrypted entity into the right table ────────

async function applyCategory(cat: SyncCategory): Promise<void> {
  await db.transaction('rw', db.categories, async () => {
    let parent_category_id: number | undefined
    if (cat.parentId) {
      const parent = await db.categories.where('sync_id').equals(cat.parentId).first()
      parent_category_id = parent?.id
    }
    const existing = await db.categories.where('sync_id').equals(cat.id).first()
    if (existing) {
      await db.categories.update(existing.id, {
        name: cat.name,
        sort_order: cat.sortOrder,
        icon: cat.icon,
        parent_sync_id: cat.parentId,
        parent_category_id,
        assigned_user_sync_ids: cat.assignedUserSyncIds ?? [],
        updated_at: cat.updatedAt,
      })
    } else {
      await db.categories.add({
        sync_id: cat.id,
        name: cat.name,
        sort_order: cat.sortOrder,
        icon: cat.icon,
        parent_sync_id: cat.parentId,
        parent_category_id,
        assigned_user_sync_ids: cat.assignedUserSyncIds ?? [],
        updated_at: cat.updatedAt,
      } as Category)
    }
  })
}

async function applyChore(chore: SyncChore): Promise<void> {
  await db.transaction('rw', db.chores, db.categories, async () => {
    const cat = chore.categorySyncId
      ? await db.categories.where('sync_id').equals(chore.categorySyncId).first()
      : undefined
    const category_id = cat?.id
    const existing = await db.chores.where('sync_id').equals(chore.id).first()
    if (existing) {
      await db.chores.update(existing.id, {
        name: chore.name,
        category_id: category_id ?? existing.category_id,
        category_sync_id: chore.categorySyncId,
        sort_order: chore.sortOrder,
        target_cadence_days: chore.targetCadenceDays,
        notify_when_overdue: chore.notifyWhenOverdue,
        auto_schedule_to_dayglance: chore.autoScheduleToDayglance,
        preferred_schedule_behavior: chore.preferredScheduleBehavior,
        seasonal_start: chore.seasonalStart ?? null,
        seasonal_end: chore.seasonalEnd ?? null,
        icon: chore.icon,
        assigned_user_sync_ids: chore.assignedUserSyncIds ?? [],
        updated_at: chore.updatedAt,
      })
    } else {
      // Category was deleted locally; skip rather than store a dangling id.
      if (category_id == null) return
      await db.chores.add({
        sync_id: chore.id,
        name: chore.name,
        category_id,
        category_sync_id: chore.categorySyncId,
        sort_order: chore.sortOrder,
        target_cadence_days: chore.targetCadenceDays,
        notify_when_overdue: chore.notifyWhenOverdue,
        auto_schedule_to_dayglance: chore.autoScheduleToDayglance,
        preferred_schedule_behavior: chore.preferredScheduleBehavior,
        seasonal_start: chore.seasonalStart ?? null,
        seasonal_end: chore.seasonalEnd ?? null,
        icon: chore.icon,
        assigned_user_sync_ids: chore.assignedUserSyncIds ?? [],
        created_at: chore.createdAt,
        updated_at: chore.updatedAt,
      } as Chore)
    }
  })
}

async function applyCompletionEvent(evt: SyncCompletionEvent): Promise<void> {
  await db.transaction('rw', db.completionEvents, db.chores, async () => {
    // Insert-only: if it is already present, leave it untouched.
    const existing = await db.completionEvents.where('sync_id').equals(evt.id).first()
    if (existing) return
    const chore = await db.chores.where('sync_id').equals(evt.choreSyncId).first()
    if (!chore) return // chore was deleted; skip orphaned event
    await db.completionEvents.add({
      sync_id: evt.id,
      chore_id: chore.id,
      completed_at: evt.completedAt,
      note: evt.note,
      source: evt.source,
      completed_by_user_sync_id: evt.completedByUserSyncId ?? null,
    } as CompletionEvent)
  })
}

async function applyUser(user: SyncUser): Promise<void> {
  await db.transaction('rw', db.users, async () => {
    const existing = await db.users.where('sync_id').equals(user.id).first()
    if (existing) {
      await db.users.update(existing.id, { name: user.name, updated_at: user.updatedAt })
    } else {
      await db.users.add({ sync_id: user.id, name: user.name, updated_at: user.updatedAt } as User)
    }
  })
}

export async function applyRemoteEntity(_entityId: string, entity: unknown): Promise<void> {
  switch (entityKind(entity)) {
    case 'category':
      await applyCategory(entity as SyncCategory)
      break
    case 'chore':
      await applyChore(entity as SyncChore)
      break
    case 'completionEvent':
      await applyCompletionEvent(entity as SyncCompletionEvent)
      break
    case 'user':
      await applyUser(entity as SyncUser)
      break
    default:
      return
  }
  notifyApplied()
}

// ── applyRemoteDelete: tombstone the id and remove it from its table ─────────

export async function applyRemoteDelete(entityId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.categories, db.chores, db.completionEvents, db.users, db.tombstones],
    async () => {
      await db.tombstones.put({ id: entityId, deleted_at: new Date().toISOString() })

      const cat = await db.categories.where('sync_id').equals(entityId).first()
      if (cat) { await db.categories.delete(cat.id); return }

      const chore = await db.chores.where('sync_id').equals(entityId).first()
      if (chore) { await db.chores.delete(chore.id); return }

      const evt = await db.completionEvents.where('sync_id').equals(entityId).first()
      if (evt) { await db.completionEvents.delete(evt.id); return }

      const user = await db.users.where('sync_id').equals(entityId).first()
      if (user) { await db.users.delete(user.id); return }
    },
  )
  notifyApplied()
}

// Mirror applyPayload's UI refresh signal so views update after a remote apply.
function notifyApplied(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('lg:sync-applied'))
  window.dispatchEvent(new CustomEvent('lg:chore-logged'))
}

// ── Engine construction ──────────────────────────────────────────────────────

export interface DbEngineCallbacks {
  onStatusChange?: (status: SyncStatus) => void
  onError?: (message: string | null, code: SyncErrorCode | null) => void
}

// Builds the DB engine when the vault is enabled and fully configured, else
// returns null (file tier only). The root key is derived from the same sync
// passphrase the file engine holds; the engine fetches or registers the salt
// with the vault automatically on first use (see ensureRootKey).
export function createDbEngine(callbacks: DbEngineCallbacks = {}): DbSyncEngine | null {
  if (!isVaultEnabled()) return null
  const cfg = getVaultConfig()!

  return createDbSyncEngine({
    storageKeyPrefix: APP_ID,
    appId: APP_ID,
    vaultApp: APP_ID,
    cryptoDBName: CRYPTO_DB_NAME,
    vaultUrl: cfg.vaultUrl,
    vaultToken: cfg.vaultToken,
    accountId: cfg.accountId,
    deviceId: getDeviceId(),
    getLocalEntity,
    applyRemoteEntity,
    applyRemoteDelete,
    isInsertOnly,
    getEntityLastModified,
    onStatusChange: callbacks.onStatusChange,
    onError: callbacks.onError,
  })
}
