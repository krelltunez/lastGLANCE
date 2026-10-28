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
import { db, isPristineSeed } from '@/db/client'
import type { Category, Chore, CompletionEvent, User } from '@/types'
import type { SyncCategory, SyncChore, SyncCompletionEvent, SyncUser } from './types'
import { getVaultConfig, isVaultEnabled } from './vaultConfig'
import { getDeviceId } from './deviceId'
import { DB_ROOT_KEY_HOOKS } from './nativeKeyHooks'
import { headlessFetchImpl } from '@/headless/headlessHttp'
import { addDeferredChore, removeDeferredChore, getDeferredChores } from './deferredChores'
import {
  addDeferredCompletion,
  removeDeferredCompletion,
  removeDeferredCompletionsForChore,
  getDeferredCompletions,
} from './deferredCompletions'

const APP_ID = 'lastglance'
const CRYPTO_DB_NAME = 'lastglance-crypto'

// Pull-cursor durability contract (@glance-apps/sync 2.0.0).
//
// 2.0.0 turned the cursor commit point into a declared mode and flipped the
// DEFAULT to 'end-of-pull', which advances the pull cursor once, after a fully
// successful pagination loop. lastGLANCE declares 'per-page' to KEEP the
// behaviour it has had since 1.10.0: the cursor advances after each completed
// page, so a large backlog on a flaky connection resumes from the last good
// page instead of re-downloading everything it already applied on every
// failure. Taking the new default would silently reintroduce exactly the
// convergence bug 1.10.0 fixed, and it would present as a network problem.
//
// 'per-page' is safe HERE because applyRemoteEntity / applyRemoteDelete write
// straight into Dexie (see the module header) and are durable the moment they
// return: there is no per-cycle mirror a later failure could discard, so the
// persisted cursor is always behind committed local state. The default flipped
// because that is NOT true of every consumer of the package (a
// commit-only-on-success composer loses rows under per-page), not because
// per-page is wrong for the callers it fits.
//
// Exported so the multi-device test exercises the real declared mode rather
// than a second copy of the literal. An unrecognised mode is refused at
// construction, so a typo throws instead of silently reverting to the default.
export const PULL_CURSOR_COMMIT = 'per-page' as const

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

// Completion events stay on the engine's insert-only ("idempotent union")
// path: apply is unconditional and never clears the dirty flag. They are no
// longer strictly immutable — notes are editable — but that's exactly why the
// union path fits: applyCompletionEvent does its own note-grain last-write-wins
// on updatedAt, and a locally dirty note edit stays dirty for the next push.
export function isInsertOnly(entity: unknown): boolean {
  return entityKind(entity) === 'completionEvent'
}

// Timestamp the engine compares for entity-grain last-writer-wins (and against
// tombstone deletedAt stamps): updatedAt everywhere, with completion events
// falling back to completedAt for shapes written before note edits synced.
//
// A pinned chore reads 1ms later than its updatedAt. A build that predates
// pinning applied pulled chores with their updatedAt but without the flag, so
// after it upgrades its copy ties the vault's pinned one, and the engine keeps
// local on a tie: the pin was lost for good. A real pin or unpin always stamps a
// new updatedAt (far more than 1ms apart), so the nudge only ever decides that
// tie, and in the pin's favour. The vault's copies still carry the pins; the
// recovery generation 3 re-pull below brings them back.
export function getEntityLastModified(entity: unknown): string | number | undefined {
  if (!entity || typeof entity !== 'object') return undefined
  const e = entity as Record<string, unknown>
  if (entityKind(e) === 'completionEvent') return (e.updatedAt ?? e.completedAt) as string | undefined
  if (entityKind(e) === 'chore' && e.pinned === true) {
    const t = Date.parse(e.updatedAt as string)
    if (!Number.isNaN(t)) return t + 1
  }
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
    details: c.details ?? null,
    pinned: c.pinned ?? false,
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
    // Rows written before updated_at existed fall back to completedAt, so a
    // note edit (which bumps updated_at) reads as newer on the receiving side.
    updatedAt: e.updated_at ?? e.completed_at,
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
        details: chore.details ?? null,
        pinned: chore.pinned ?? existing.pinned ?? false,
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
        details: chore.details ?? null,
        pinned: chore.pinned ?? false,
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
    // Events are immutable EXCEPT the note, which updateCompletionNote edits
    // after the fact (bumping updated_at). If we already hold the event, adopt
    // the incoming note when the incoming updatedAt is strictly newer
    // (last-write-wins; ties keep local, matching the file tier's merge).
    const existing = await db.completionEvents.where('sync_id').equals(evt.id).first()
    if (existing) {
      const incomingUpdated = evt.updatedAt ?? evt.completedAt
      const localUpdated = existing.updated_at ?? existing.completed_at
      if (new Date(incomingUpdated).getTime() > new Date(localUpdated).getTime()) {
        await db.completionEvents.update(existing.id!, { note: evt.note, updated_at: incomingUpdated })
      }
      return
    }
    const chore = await db.chores.where('sync_id').equals(evt.choreSyncId).first()
    // The chore may not be present yet (it arrives later in seq order when it was
    // edited after this completion, or it is itself parked awaiting its category),
    // OR it may have been deleted. We cannot tell the two apart here, so park the
    // event and let drainDeferredCompletions retry once a chore with this sync_id
    // lands. A completion is only re-listed if its note is later edited, so
    // dropping it here would (in the common case) lose it permanently — that was
    // the "some completions never arrive" bug.
    if (!chore) { skipped = true; return }
    await db.completionEvents.add({
      sync_id: evt.id,
      chore_id: chore.id,
      completed_at: evt.completedAt,
      updated_at: evt.updatedAt ?? evt.completedAt,
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
//   gen 3:          re-pull so pins a pre-pinning build dropped on apply come
//                   back (see getEntityLastModified's tie-break for pinned
//                   chores, without which the re-pulled copy would lose the tie).
//
// A generation rewind forces a full re-PULL only. It deliberately no longer
// re-snapshot-pushes local data (the seed gate below is a one-shot flag, not an
// HWM check): both existing generations were pull-side fixes, and push-side
// loss has always been covered by dirty-retention-until-ack. If a FUTURE
// generation ever needs a forced re-push (e.g. after server-side data loss), it
// must ALSO remove SNAPSHOT_SEEDED_FLAG — rewinding the cursor alone will not
// re-seed.
const RECOVERY_GENERATION = 3
const HWM_RECOVERY_FLAG = `${APP_ID}-db-sync-hwm-recovery-gen`

// One-shot gate for the first-sync full-snapshot seed (see the seeding wrapper
// in createDbEngine). Present-and-'1' means this device has completed its
// initial marking; the engine's persisted dirty set owns delivery from there.
const SNAPSHOT_SEEDED_FLAG = `${APP_ID}-db-sync-snapshot-seeded`

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
//
// Pristine sample data is deliberately EXCLUDED. Seed rows share fixed sync_ids
// and a frozen timestamp across every fresh install, so if a freshly-installed
// device pushed its untouched seed on first sync, that stale copy would upsert
// over — and overwrite — another device's edits to the same seed sync_id (the
// vault push cycle pushes before it pulls, and the push is an unconditional
// upsert with no updatedAt check). Keeping untouched seed local-only avoids the
// clobber while preserving the no-doubling property (nothing to double if it
// never syncs). The moment a user edits a seed row its updated_at bumps, so it
// is no longer pristine and syncs normally; deletes still propagate as
// tombstones.
export async function markAllLocalEntitiesDirty(engine: DbSyncEngine): Promise<void> {
  const [cats, chores, events, users] = await Promise.all([
    db.categories.toArray(),
    db.chores.toArray(),
    db.completionEvents.toArray(),
    db.users.toArray(),
  ])
  for (const c of cats) if (!isPristineSeed(c)) engine.markDirty(c.sync_id)
  for (const c of chores) if (!isPristineSeed(c)) engine.markDirty(c.sync_id)
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
    // Keystore-backed root-key storage on Android (issue #210) — must be the
    // DB-tier pair; see the note on CRYPTO_CONFIG / DB_CRYPTO_CONFIG.
    ...DB_ROOT_KEY_HOOKS,
    vaultUrl: cfg.vaultUrl,
    vaultToken: cfg.vaultToken,
    // A headless refresh has no CapacitorHttp; the shell's HTTP stands in.
    fetchImpl: headlessFetchImpl(),
    accountId: cfg.accountId,
    deviceId: getDeviceId(),
    getLocalEntity,
    applyRemoteEntity,
    applyRemoteDelete,
    isInsertOnly,
    getEntityLastModified,
    pullCursorCommit: PULL_CURSOR_COMMIT,
    onStatusChange: callbacks.onStatusChange,
    onError: callbacks.onError,
    onRowsSkipped: callbacks.onRowsSkipped,
  })

  // Recover devices whose pull cursor was poisoned by the ≤1.3.x push/pull bug
  // before deciding whether this is a first-ever sync below. The cursor rewind
  // no longer re-triggers the snapshot seed (the seed gate is a one-shot flag,
  // not an HWM check) — under SSE a rewind-triggered re-seed would not be
  // harmless; see the seeding wrapper below.
  recoverStalePullCursor(engine)

  // Repair categories that were stored flat by an earlier build, immediately on
  // open. A re-pull cannot fix these (last-writer-wins skips already-present rows
  // whose updatedAt is unchanged), but their parent_sync_id and parent row are
  // already local, so this relinks them. Fire-and-forget; refresh the UI if it
  // changed anything so the nesting appears without waiting for a sync.
  resolveCategoryParents()
    .then((n) => { if (n > 0) notifyApplied() })
    .catch((err) => console.warn('[lastglance] category parent repair failed:', err))

  // On the first ever sync, seed the dirty set with the full local dataset so
  // existing users get everything pushed, not just new changes.
  //
  // The gate is a ONE-SHOT PERSISTED FLAG (lifeGLANCE's pattern), set only
  // after marking completes — NOT the old `getHighWaterMark() === 0` check.
  // The HWM gate re-ran the full-snapshot mark on EVERY cycle until a pull
  // succeeded, and the server nudges on byte-identical re-upserts, so with
  // push succeeding while the pull was failing or backed off (exactly the
  // state 1.9.0's push/pull decoupling sustains) each cycle re-pushed the
  // whole dataset — under SSE, a self-nudge loop: push → own activity nudge →
  // drain → re-mark (HWM still 0) → push. The flag latches after ONE
  // successful marking; the engine's persisted dirty set then carries the
  // seed until it is fully acked (pushDirtyRows only clears on full ack), so
  // delivery stays guaranteed without ever re-marking. A marking FAILURE
  // leaves the flag unset, so the next cycle retries. Seeding failures are
  // non-fatal: the normal cycle still proceeds.
  //
  // Migration shim: a device upgrading from the HWM gate has no flag, but a
  // pull cursor past 0 proves its first sync completed long ago — latch the
  // flag without re-marking, so the upgrade does not trigger a fleet-wide
  // burst of redundant full-snapshot pushes (and their nudges).
  const runCycle = engine.dbSyncCycle.bind(engine)
  const dbSyncCycle = async (): Promise<DbSyncResult> => {
    if (localStorage.getItem(SNAPSHOT_SEEDED_FLAG) !== '1') {
      if (engine.getHighWaterMark() > 0) {
        localStorage.setItem(SNAPSHOT_SEEDED_FLAG, '1')
      } else {
        try {
          await markAllLocalEntitiesDirty(engine)
          localStorage.setItem(SNAPSHOT_SEEDED_FLAG, '1')
        } catch (err) {
          console.warn('[lastglance] vault initial snapshot failed:', err)
        }
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

