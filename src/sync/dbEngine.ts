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
import type { DbSyncEngine, DbSyncResult, SyncStatus, SyncErrorCode } from '@glance-apps/sync'
import { db } from '@/db/client'
import type { Category, Chore, CompletionEvent, User } from '@/types'
import type { SyncCategory, SyncChore, SyncCompletionEvent, SyncUser } from './types'
import { getVaultConfig, isVaultEnabled } from './vaultConfig'
import { getDeviceId } from './deviceId'
import { addDeferredChore, removeDeferredChore, getDeferredChores } from './deferredChores'
import {
  addDeferredCompletion,
  removeDeferredCompletion,
  removeDeferredCompletionsForChore,
  getDeferredCompletions,
} from './deferredCompletions'

const APP_ID = 'lastglance'
const CRYPTO_DB_NAME = 'lastglance-crypto'

// User-facing text for the typed vault (DB transport) error codes is no longer
// mapped here. The engine emits a typed SyncErrorCode alongside its message on
// onError; the client localizes it at render time via syncErrorText (see
// src/sync/syncErrorText.ts) keyed by `sync.errors.<CODE>`. PASSPHRASE_REQUIRED
// is still intercepted by the App's onError (it prompts for the passphrase rather
// than surfacing text); every other code flows through the shared helper.

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
  // A child can arrive before its parent (vault seq order is not parents-first),
  // so back-fill any unresolved parent links now that this row has landed.
  await resolveCategoryParents()
  // A newly present category may unblock chores that arrived before it.
  await drainDeferredChores()
}

// Back-fill parent_category_id for any category that carries a parent_sync_id
// but has no resolved local FK yet, and report how many rows it fixed.
//
// Two situations need this. (1) The DB transport applies categories one row at a
// time in vault seq order, so a subcategory can be written before its parent
// exists locally; unlike the file tier's two-pass applyPayload, a single
// applyCategory cannot resolve a not-yet-present parent and leaves the FK unset.
// (2) A device that received its categories flat under an earlier build still has
// them flat: a re-pull will NOT repair them, because @glance-apps/sync skips an
// already-present row whose updatedAt is not strictly newer (last-writer-wins), so
// applyCategory never re-runs for them. The parent row and parent_sync_id are both
// present locally, so this standalone pass relinks them regardless of the pull.
//
// This matters because the UI groups strictly by parent_category_id (see
// useChores.ts): a row with a null/undefined FK renders as a ROOT category, so
// every unlinked subcategory shows up flattened to a top-level category. Idempotent
// and cheap (the categories table is tiny).
export async function resolveCategoryParents(): Promise<number> {
  let changed = 0
  await db.transaction('rw', db.categories, async () => {
    const cats = await db.categories.toArray()
    const idBySyncId = new Map(cats.map(c => [c.sync_id, c.id]))
    for (const c of cats) {
      if (!c.parent_sync_id || c.parent_category_id != null) continue
      const parentId = idBySyncId.get(c.parent_sync_id)
      if (parentId != null) {
        await db.categories.update(c.id!, { parent_category_id: parentId })
        changed++
      }
    }
  })
  return changed
}

async function applyChore(chore: SyncChore): Promise<void> {
  let skipped = false
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
      // Category not present yet (arrived out of seq order) or deleted: do not
      // store a dangling id. Park the chore and retry when a category lands.
      if (category_id == null) { skipped = true; return }
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
  // Buffer the chore when skipped; clear it from the buffer once applied.
  if (skipped) {
    addDeferredChore(chore)
  } else {
    removeDeferredChore(chore.id)
    // The chore is now present, so any completion events parked waiting on it can
    // be applied. Chains correctly when this chore itself was drained after its
    // category landed (applyCategory → drainDeferredChores → applyChore → here).
    await drainDeferredCompletions()
  }
}

// Re-apply parked chores whose category is now present locally. Called after a
// category is applied. applyChore removes each from the buffer on success and
// re-parks any that still cannot resolve, so this is safe to call repeatedly.
async function drainDeferredChores(): Promise<void> {
  const deferred = getDeferredChores()
  if (deferred.length === 0) return
  for (const chore of deferred) {
    const cat = chore.categorySyncId
      ? await db.categories.where('sync_id').equals(chore.categorySyncId).first()
      : undefined
    if (cat) await applyChore(chore)
  }
}

async function applyCompletionEvent(evt: SyncCompletionEvent): Promise<void> {
  let skipped = false
  await db.transaction('rw', db.completionEvents, db.chores, async () => {
    // Insert-only: if it is already present, leave it untouched.
    const existing = await db.completionEvents.where('sync_id').equals(evt.id).first()
    if (existing) return
    const chore = await db.chores.where('sync_id').equals(evt.choreSyncId).first()
    // The chore may not be present yet (it arrives later in seq order when it was
    // edited after this completion, or it is itself parked awaiting its category),
    // OR it may have been deleted. We cannot tell the two apart here, so park the
    // event and let drainDeferredCompletions retry once a chore with this sync_id
    // lands. A completion is insert-only and never re-listed, so dropping it here
    // would lose it permanently — that was the "some completions never arrive" bug.
    if (!chore) { skipped = true; return }
    await db.completionEvents.add({
      sync_id: evt.id,
      chore_id: chore.id,
      completed_at: evt.completedAt,
      note: evt.note,
      source: evt.source,
      completed_by_user_sync_id: evt.completedByUserSyncId ?? null,
    } as CompletionEvent)
  })
  // Buffer the event when skipped; clear it from the buffer once applied/present.
  if (skipped) addDeferredCompletion(evt)
  else removeDeferredCompletion(evt.id)
}

// Re-apply parked completions whose chore is now present locally. Called after a
// chore is applied. applyCompletionEvent removes each from the buffer on success
// and re-parks any that still cannot resolve, so this is safe to call repeatedly.
async function drainDeferredCompletions(): Promise<void> {
  const deferred = getDeferredCompletions()
  if (deferred.length === 0) return
  for (const evt of deferred) {
    const chore = await db.chores.where('sync_id').equals(evt.choreSyncId).first()
    if (chore) await applyCompletionEvent(evt)
  }
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
  // Drop any parked copy so a deleted entity is never resurrected by a later
  // drain: the chore itself, a parked completion with this id, and any parked
  // completions that belonged to a now-deleted chore (their chore will never land).
  removeDeferredChore(entityId)
  removeDeferredCompletion(entityId)
  removeDeferredCompletionsForChore(entityId)
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
  // Fired once per cycle that skipped > 0 undecryptable rows (@glance-apps/sync
  // 1.5.0 per-row quarantine). We keep using the engine's own dbSyncCycle, so the
  // engine invokes this for us; we only forward it to the UI signal.
  onRowsSkipped?: (count: number, entityIds: string[]) => void
}

// One-time recovery for devices upgrading from @glance-apps/sync ≤ 1.3.x.
//
// In 1.3.x a push advanced the SAME high-water mark that the pull resumes from,
// so any cycle that pushed local dirty rows bumped the cursor to the highest seq
// in the account — past unread, lower-seq peer rows, which were then skipped on
// every subsequent pull. That is permanent for insert-only completion events
// (they are never re-written, so a later pull never re-lists them). 1.4.0 splits
// the cursors (KEY_HWM vs KEY_PUSH_ACK) to stop NEW pollution, but it inherits
// the already-stored KEY_HWM as pull progress, so a device that was polluted
// under 1.3.x stays stuck and never recovers the skipped rows — exactly the
// "completions won't sync no matter what" symptom.
//
// Reset the pull cursor to 0 once so the next pull re-lists the full account
// history. Every apply is idempotent (categories/chores/users upsert by sync_id
// with last-writer-wins; completion events are insert-only and skip if present,
// and orphaned rows are now parked rather than dropped), so a full re-pull only
// fills the holes and cannot clobber newer local data.
//
// Tracked by a monotonic generation rather than a boolean: each generation that
// requires devices to re-pull the full history once bumps RECOVERY_GENERATION,
// and a device re-runs the reset whenever its stored generation is behind.
//   gen 1 (v1.8.6): split-cursor poisoning from @glance-apps/sync ≤ 1.3.x.
//   gen 2 (v1.8.7): re-pull so completions dropped on a not-yet-present chore by
//                   the old applyCompletionEvent are re-listed and now parked.
const RECOVERY_GENERATION = 2
const HWM_RECOVERY_FLAG = `${APP_ID}-db-sync-hwm-recovery-gen`

function recoverStalePullCursor(engine: DbSyncEngine): void {
  if (typeof localStorage === 'undefined') return
  // NaN (absent / legacy timestamp value) is treated as behind, so it runs.
  const done = Number(localStorage.getItem(HWM_RECOVERY_FLAG))
  if (done >= RECOVERY_GENERATION) return
  try {
    if (engine.getHighWaterMark() > 0) engine.setHighWaterMark(0)
  } catch (err) {
    console.warn('[lastglance] vault pull-cursor recovery failed:', err)
  } finally {
    localStorage.setItem(HWM_RECOVERY_FLAG, String(RECOVERY_GENERATION))
  }
}

// Marks every local entity dirty so the next push sends a complete snapshot.
// Used for the first ever sync on a device (high water mark 0): existing users
// who enable the vault have data that predates dirty tracking, so without this
// only future changes would be pushed. pushDirtyRows then snapshots each id via
// getLocalEntity. markDirty is idempotent, so repeating this before a successful
// first push is harmless.
export async function markAllLocalEntitiesDirty(engine: DbSyncEngine): Promise<void> {
  const [cats, chores, events, users] = await Promise.all([
    db.categories.toArray(),
    db.chores.toArray(),
    db.completionEvents.toArray(),
    db.users.toArray(),
  ])
  for (const c of cats) engine.markDirty(c.sync_id)
  for (const c of chores) engine.markDirty(c.sync_id)
  for (const e of events) engine.markDirty(e.sync_id)
  for (const u of users) engine.markDirty(u.sync_id)
}

// Builds the DB engine when the vault is enabled and fully configured, else
// returns null (file tier only). The root key is derived from the same sync
// passphrase the file engine holds; the engine fetches or registers the salt
// with the vault automatically on first use (see ensureRootKey).
export function createDbEngine(callbacks: DbEngineCallbacks = {}): DbSyncEngine | null {
  if (!isVaultEnabled()) return null
  const cfg = getVaultConfig()!

  const engine = createDbSyncEngine({
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
    onRowsSkipped: callbacks.onRowsSkipped,
  })

  // Recover devices whose pull cursor was poisoned by the ≤1.3.x push/pull bug
  // before deciding whether this is a first-ever sync below. Resetting to 0 here
  // also makes the seeding wrapper re-snapshot local data, which is harmless.
  recoverStalePullCursor(engine)

  // Repair categories that were stored flat by an earlier build, immediately on
  // open. A re-pull cannot fix these (last-writer-wins skips already-present rows
  // whose updatedAt is unchanged), but their parent_sync_id and parent row are
  // already local, so this relinks them. Fire-and-forget; refresh the UI if it
  // changed anything so the nesting appears without waiting for a sync.
  resolveCategoryParents()
    .then((n) => { if (n > 0) notifyApplied() })
    .catch((err) => console.warn('[lastglance] category parent repair failed:', err))

  // On the first ever sync (high water mark 0), seed the dirty set with the full
  // local dataset so existing users get everything pushed, not just new changes.
  // After a successful first push the high water mark advances past 0, so this
  // runs once. Seeding failures are non-fatal: the normal cycle still proceeds.
  const runCycle = engine.dbSyncCycle.bind(engine)
  const dbSyncCycle = async (): Promise<DbSyncResult> => {
    if (engine.getHighWaterMark() === 0) {
      try {
        await markAllLocalEntitiesDirty(engine)
      } catch (err) {
        console.warn('[lastglance] vault initial snapshot failed:', err)
      }
    }
    // The engine's own dbSyncCycle fires config.onRowsSkipped for any quarantined
    // rows and resolves to { applied, skipped, skippedEntityIds }; pass that result
    // straight through so callers can surface the per-cycle skip count.
    const result = await runCycle()
    // A pull may have skipped already-present rows under last-writer-wins, so run
    // the repair after every cycle too; refresh the UI when it links anything.
    try {
      if ((await resolveCategoryParents()) > 0) notifyApplied()
    } catch (err) {
      console.warn('[lastglance] category parent repair failed:', err)
    }
    return result
  }

  return { ...engine, dbSyncCycle, sync: dbSyncCycle }
}

