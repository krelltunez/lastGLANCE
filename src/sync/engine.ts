import {
  createSyncEngine,
  mergeArrayById,
  pruneTombstones,
  initSessionKey,
  setupEncryptionKey,
  clearEncryptionKey,
  AUTO_BACKUP_INTERVALS,
} from '@glance-apps/sync'
import type { SyncEngine, SyncStatus, SyncErrorCode, BackupFrequency } from '@glance-apps/sync'
import { db } from '@/db/client'
import type { Category, Chore, CompletionEvent, User } from '@/types'
import { buildAuthHeader, ensureFolder, forgetEnsuredFolders } from '@/intents/webdav'
import { browserDirectFetch, isNativePlatform, nativeHttpFetch, webdavDirect } from './nativeHttp'
import type { SyncPayload, SyncSettings } from './types'
import { getMultiUserEnabled, setMultiUserEnabled } from '@/multiuser/settings'

export const CRYPTO_CONFIG = { cryptoDBName: 'lastglance-crypto' }
export const DEFAULT_SYNC_FOLDER = 'GLANCE/lastglance'
export const SYNC_FOLDER_KEY = 'lastglance-cloud-sync-folder'

export { initSessionKey, setupEncryptionKey, clearEncryptionKey }

// buildPayload: read all Dexie tables, map to sync shapes
export const buildPayload = async (): Promise<SyncPayload> => {
  const [categories, chores, completionEvents, tombstoneRows, users] = await Promise.all([
    db.categories.toArray(),
    db.chores.toArray(),
    db.completionEvents.toArray(),
    db.tombstones.toArray(),
    db.users.toArray(),
  ])

  const tombstones: Record<string, string> = {}
  for (const t of tombstoneRows) {
    if (uuidRe.test(t.id)) tombstones[t.id] = t.deleted_at
  }

  const choreMap = new Map(chores.map(c => [c.id!, c.sync_id]))

  const settings: SyncSettings = {
    multiUserEnabled: getMultiUserEnabled(),
  }

  return {
    categories: categories.map(c => ({
      id: c.sync_id,
      name: c.name,
      sortOrder: c.sort_order,
      icon: c.icon,
      parentId: c.parent_sync_id,
      assignedUserSyncIds: c.assigned_user_sync_ids ?? [],
      updatedAt: c.updated_at,
    })),
    chores: chores.map(c => ({
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
    })),
    completionEvents: completionEvents.flatMap(e => {
      const choreSyncId = choreMap.get(e.chore_id) ?? ''
      if (!uuidRe.test(e.sync_id) || !uuidRe.test(choreSyncId)) return []
      return [{ id: e.sync_id, choreSyncId, completedAt: e.completed_at, note: e.note, source: e.source, completedByUserSyncId: e.completed_by_user_sync_id ?? null }]
    }),
    users: users.map(u => ({
      id: u.sync_id,
      name: u.name,
      updatedAt: u.updated_at,
    })),
    settings,
    tombstones,
  }
}

// Deduplicate an array by a string key field, keeping the last occurrence.
// Prevents bloated/corrupt sync files from causing O(N²) merge behaviour.
function dedupeById<T extends Record<string, unknown>>(arr: T[], idField: string): T[] {
  const seen = new Map<string, T>()
  for (const item of arr) seen.set(item[idField] as string, item)
  return Array.from(seen.values())
}

// mergePayloads: synchronous merge of local and remote payloads
export const mergePayloads = (
  local: unknown,
  remote: unknown,
): { data: unknown; localChanged: boolean; remoteChanged: boolean } => {
  const l = (local ?? { chores: [], categories: [], completionEvents: [], users: [], settings: { multiUserEnabled: false }, tombstones: {} }) as SyncPayload
  const r = (remote ?? { chores: [], categories: [], completionEvents: [], users: [], settings: { multiUserEnabled: false }, tombstones: {} }) as SyncPayload

  const rawTombstones: Record<string, string> = { ...l.tombstones, ...r.tombstones }
  const allTombstones: Record<string, string> = {}
  for (const [k, v] of Object.entries(rawTombstones)) {
    if (uuidRe.test(k)) allTombstones[k] = v
  }
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  const tombstones = pruneTombstones(allTombstones, cutoff)

  type R = Record<string, unknown>
  const lCats   = dedupeById(l.categories       as unknown as R[] ?? [], 'id')
  const rCats   = dedupeById(r.categories       as unknown as R[] ?? [], 'id')
  const lChores = dedupeById(l.chores           as unknown as R[] ?? [], 'id')
  const rChores = dedupeById(r.chores           as unknown as R[] ?? [], 'id')
  const lEvts   = dedupeById((l.completionEvents as unknown as R[] ?? []).filter((e: R) => uuidRe.test(e.id as string) && uuidRe.test(e.choreSyncId as string)), 'id')
  const rEvts   = dedupeById((r.completionEvents as unknown as R[] ?? []).filter((e: R) => uuidRe.test(e.id as string) && uuidRe.test(e.choreSyncId as string)), 'id')
  const lUsers  = dedupeById(l.users            as unknown as R[] ?? [], 'id')
  const rUsers  = dedupeById(r.users            as unknown as R[] ?? [], 'id')

  const catMerge  = mergeArrayById(lCats,   rCats,   tombstones, null, { idField: 'id', timestampField: 'updatedAt' })
  const choreMerge = mergeArrayById(lChores, rChores, tombstones, null, { idField: 'id', timestampField: 'updatedAt' })
  const evtMerge  = mergeArrayById(lEvts,   rEvts,   tombstones, null, { idField: 'id', timestampField: 'completedAt' })
  const userMerge = mergeArrayById(lUsers,  rUsers,  tombstones, null, { idField: 'id', timestampField: 'updatedAt' })

  // Settings: OR the multiUserEnabled flag (if either side turned it on, keep it on)
  const mergedSettings: SyncSettings = {
    multiUserEnabled: !!(l.settings?.multiUserEnabled || r.settings?.multiUserEnabled),
  }
  const settingsLocalChanged = !!(r.settings?.multiUserEnabled && !l.settings?.multiUserEnabled)
  const settingsRemoteChanged = !!(l.settings?.multiUserEnabled && !r.settings?.multiUserEnabled)

  return {
    data: {
      categories: catMerge.merged,
      chores: choreMerge.merged,
      completionEvents: evtMerge.merged,
      users: userMerge.merged,
      settings: mergedSettings,
      tombstones,
    } as unknown as SyncPayload,
    localChanged: catMerge.localChanged || choreMerge.localChanged || evtMerge.localChanged || userMerge.localChanged || settingsLocalChanged,
    remoteChanged: catMerge.remoteChanged || choreMerge.remoteChanged || evtMerge.remoteChanged || userMerge.remoteChanged || settingsRemoteChanged,
  }
}

function validateSyncPayload(data: SyncPayload): void {
  const isoRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/
  const mmddRe = /^\d{2}-\d{2}$/
  for (const c of (data.categories ?? [])) {
    if (!uuidRe.test(c.id)) throw new Error('invalid category id')
    if (typeof c.name !== 'string' || c.name.length === 0 || c.name.length > 500) throw new Error('invalid category name')
    if (typeof c.sortOrder !== 'number') throw new Error('invalid category sortOrder')
    if (!isoRe.test(c.updatedAt)) throw new Error('invalid category updatedAt')
  }
  for (const c of (data.chores ?? [])) {
    if (!uuidRe.test(c.id)) throw new Error('invalid chore id')
    if (typeof c.name !== 'string' || c.name.length === 0 || c.name.length > 500) throw new Error('invalid chore name')
    if (typeof c.sortOrder !== 'number') throw new Error('invalid chore sortOrder')
    if (!isoRe.test(c.createdAt)) throw new Error('invalid chore createdAt')
    if (!isoRe.test(c.updatedAt)) throw new Error('invalid chore updatedAt')
    if (c.seasonalStart != null && !mmddRe.test(c.seasonalStart)) throw new Error('invalid chore seasonalStart')
    if (c.seasonalEnd != null && !mmddRe.test(c.seasonalEnd)) throw new Error('invalid chore seasonalEnd')
  }
  for (const e of (data.completionEvents ?? [])) {
    if (!uuidRe.test(e.id)) throw new Error('invalid completionEvent id')
    if (!uuidRe.test(e.choreSyncId)) throw new Error('invalid completionEvent choreSyncId')
    if (!isoRe.test(e.completedAt)) throw new Error('invalid completionEvent completedAt')
    if (e.source !== 'manual' && e.source !== 'dayglance') throw new Error('invalid completionEvent source')
    if (e.completedByUserSyncId != null && !uuidRe.test(e.completedByUserSyncId)) throw new Error('invalid completionEvent completedByUserSyncId')
  }
  for (const u of (data.users ?? [])) {
    if (!uuidRe.test(u.id)) throw new Error('invalid user id')
    if (typeof u.name !== 'string' || u.name.length === 0 || u.name.length > 100) throw new Error('invalid user name')
    if (!isoRe.test(u.updatedAt)) throw new Error('invalid user updatedAt')
  }
  for (const [syncId, deletedAt] of Object.entries(data.tombstones ?? {})) {
    if (!uuidRe.test(syncId)) throw new Error('invalid tombstone id')
    if (!isoRe.test(deletedAt)) throw new Error('invalid tombstone deletedAt')
  }
}

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Strip records with non-UUID ids written by pre-dedup builds.
function sanitizePayload(data: SyncPayload): SyncPayload {
  const result = { ...data }

  if (data.completionEvents?.length) {
    const bad = data.completionEvents.filter(e => !uuidRe.test(e.id) || !uuidRe.test(e.choreSyncId))
    if (bad.length) {
      for (const e of bad) console.warn('[lastglance] sanitizePayload: dropping legacy completionEvent', JSON.stringify(e))
      result.completionEvents = data.completionEvents.filter(e => uuidRe.test(e.id) && uuidRe.test(e.choreSyncId))
    }
  }

  if (data.tombstones && Object.keys(data.tombstones).length) {
    const badKeys = Object.keys(data.tombstones).filter(k => !uuidRe.test(k))
    if (badKeys.length) {
      for (const k of badKeys) console.warn('[lastglance] sanitizePayload: dropping legacy tombstone', k, data.tombstones![k])
      const clean = { ...data.tombstones }
      for (const k of badKeys) delete clean[k]
      result.tombstones = clean
    }
  }

  return result
}

// applyPayload: write merged data back to Dexie (two-pass for categories)
export const applyPayload = async (rawData: unknown, { allowEmpty }: { allowEmpty: boolean }): Promise<void> => {
  const data = sanitizePayload(rawData as SyncPayload)
  if (!allowEmpty && !data?.chores?.length && !data?.categories?.length && !data?.completionEvents?.length && !data?.users?.length) return
  validateSyncPayload(data)

  // Apply synced settings to localStorage (device-local "me" is NOT overwritten)
  if (typeof data.settings?.multiUserEnabled === 'boolean') {
    setMultiUserEnabled(data.settings.multiUserEnabled)
  }

  const tombstoneIds = new Set(Object.keys(data.tombstones ?? {}))

  await db.transaction('rw', [db.categories, db.chores, db.completionEvents, db.tombstones, db.users], async () => {
    // ── Bulk-fetch existing records into Maps for O(1) lookup ──
    const [existingCats, existingChores, existingEvents, existingUsers] = await Promise.all([
      db.categories.toArray(),
      db.chores.toArray(),
      db.completionEvents.toArray(),
      db.users.toArray(),
    ])
    const catBySyncId    = new Map(existingCats.map(c => [c.sync_id,  c]))
    const choreBySyncId  = new Map(existingChores.map(c => [c.sync_id, c]))
    const eventBySyncId  = new Map(existingEvents.map(e => [e.sync_id, e]))
    const userBySyncId   = new Map(existingUsers.map(u => [u.sync_id,  u]))

    // ── CATEGORIES pass 1: upsert by sync_id ──
    // `id` is Dexie's auto-increment key, assigned on insert, so the accumulators
    // hold the entity minus `id`; the bulkAdd casts back (Dexie fills it in).
    const catsToAdd: Omit<Category, 'id'>[] = []
    const catsToUpdate: Array<[number, object]> = []
    for (const cat of (data.categories ?? [])) {
      if (tombstoneIds.has(cat.id)) continue
      const existing = catBySyncId.get(cat.id)
      if (existing) {
        catsToUpdate.push([existing.id!, {
          name: cat.name, sort_order: cat.sortOrder, icon: cat.icon,
          parent_sync_id: cat.parentId, updated_at: cat.updatedAt,
          assigned_user_sync_ids: cat.assignedUserSyncIds ?? [],
        }])
      } else {
        catsToAdd.push({
          sync_id: cat.id, name: cat.name, sort_order: cat.sortOrder,
          icon: cat.icon, parent_sync_id: cat.parentId,
          parent_category_id: undefined, updated_at: cat.updatedAt,
          assigned_user_sync_ids: cat.assignedUserSyncIds ?? [],
        })
      }
    }
    await Promise.all(catsToUpdate.map(([id, fields]) => db.categories.update(id, fields)))
    await db.categories.bulkAdd(catsToAdd as Category[])

    // ── CATEGORIES pass 2: resolve parent_sync_id → parent_category_id ──
    // Re-fetch after inserts so new categories are in the map
    const allCatsAfterUpsert = await db.categories.toArray()
    const catBySync2 = new Map(allCatsAfterUpsert.map(c => [c.sync_id, c]))
    const parentUpdates: Array<[number, object]> = []
    for (const cat of (data.categories ?? [])) {
      if (!cat.parentId || tombstoneIds.has(cat.id)) continue
      const child = catBySync2.get(cat.id)
      if (!child) continue
      const parent = catBySync2.get(cat.parentId)
      if (parent) {
        parentUpdates.push([child.id!, { parent_category_id: parent.id }])
      } else {
        parentUpdates.push([child.id!, { parent_category_id: undefined, parent_sync_id: null }])
      }
    }
    await Promise.all(parentUpdates.map(([id, fields]) => db.categories.update(id, fields)))

    // ── Delete tombstoned categories ──
    const catTombstoneIds = [...tombstoneIds]
      .map(sid => catBySyncId.get(sid)?.id)
      .filter((id): id is number => id != null)
    await db.categories.bulkDelete(catTombstoneIds)

    // ── CHORES: upsert by sync_id ──
    // Re-fetch categories (tombstones may have been deleted) for category_id resolution
    const allCatsForChores = await db.categories.toArray()
    const catMapForChores = new Map(allCatsForChores.map(c => [c.sync_id, c]))
    const choresToAdd: Omit<Chore, 'id'>[] = []
    const choresToUpdate: Array<[number, object]> = []
    for (const chore of (data.chores ?? [])) {
      if (tombstoneIds.has(chore.id)) continue
      const category_id = chore.categorySyncId ? catMapForChores.get(chore.categorySyncId)?.id : undefined
      const existing = choreBySyncId.get(chore.id)
      if (existing) {
        choresToUpdate.push([existing.id!, {
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
        }])
      } else {
        if (!category_id) continue  // category was deleted; skip rather than store category_id: 0
        choresToAdd.push({
          sync_id: chore.id, name: chore.name, category_id,
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
          created_at: chore.createdAt, updated_at: chore.updatedAt,
        })
      }
    }
    await Promise.all(choresToUpdate.map(([id, fields]) => db.chores.update(id, fields)))
    await db.chores.bulkAdd(choresToAdd as Chore[])

    // ── Delete tombstoned chores ──
    const choreTombstoneIds = [...tombstoneIds]
      .map(sid => choreBySyncId.get(sid)?.id)
      .filter((id): id is number => id != null)
    await db.chores.bulkDelete(choreTombstoneIds)

    // ── COMPLETION EVENTS: insert new ones only (events are immutable) ──
    // Re-fetch chores after upsert for chore_id resolution
    const allChoresForEvents = await db.chores.toArray()
    const choreMapForEvents = new Map(allChoresForEvents.map(c => [c.sync_id, c]))
    const eventsToAdd: Omit<CompletionEvent, 'id'>[] = []
    for (const evt of (data.completionEvents ?? [])) {
      if (tombstoneIds.has(evt.id)) continue
      if (eventBySyncId.has(evt.id)) continue  // immutable; already present
      const chore = choreMapForEvents.get(evt.choreSyncId)
      if (!chore) continue  // chore was deleted; skip orphaned events
      eventsToAdd.push({
        sync_id: evt.id, chore_id: chore.id!,
        completed_at: evt.completedAt, note: evt.note, source: evt.source,
        completed_by_user_sync_id: evt.completedByUserSyncId ?? null,
      })
    }
    await db.completionEvents.bulkAdd(eventsToAdd as CompletionEvent[])

    // ── Delete tombstoned completion events ──
    const evtTombstoneIds = [...tombstoneIds]
      .map(sid => eventBySyncId.get(sid)?.id)
      .filter((id): id is number => id != null)
    await db.completionEvents.bulkDelete(evtTombstoneIds)

    // ── USERS: upsert by sync_id ──
    const usersToAdd: Omit<User, 'id'>[] = []
    const usersToUpdate: Array<[number, object]> = []
    for (const user of (data.users ?? [])) {
      if (tombstoneIds.has(user.id)) continue
      const existing = userBySyncId.get(user.id)
      if (existing) {
        usersToUpdate.push([existing.id!, { name: user.name, updated_at: user.updatedAt }])
      } else {
        usersToAdd.push({ sync_id: user.id, name: user.name, updated_at: user.updatedAt })
      }
    }
    await Promise.all(usersToUpdate.map(([id, fields]) => db.users.update(id, fields)))
    await db.users.bulkAdd(usersToAdd as User[])

    // ── Delete tombstoned users ──
    const userTombstoneIds = [...tombstoneIds]
      .map(sid => userBySyncId.get(sid)?.id)
      .filter((id): id is number => id != null)
    await db.users.bulkDelete(userTombstoneIds)

    // ── Persist tombstones ──
    await db.tombstones.bulkPut(
      Object.entries(data.tombstones ?? {}).map(([id, deleted_at]) => ({ id, deleted_at }))
    )
  })

  // Notify UI to refresh
  window.dispatchEvent(new CustomEvent('lg:sync-applied'))
  window.dispatchEvent(new CustomEvent('lg:chore-logged'))
}

const BACKUP_LS_KEY = (freq: BackupFrequency) => `lastglance_backup_last_${freq}`
export const REMOTE_BACKUPS_ENABLED_KEY = 'lastglance_remote_backups_enabled'

export function getRemoteBackupsEnabled(): boolean {
  return localStorage.getItem(REMOTE_BACKUPS_ENABLED_KEY) === 'true'
}

export function setRemoteBackupsEnabled(enabled: boolean): void {
  localStorage.setItem(REMOTE_BACKUPS_ENABLED_KEY, String(enabled))
}

const _backupInProgress = new WeakSet<SyncEngine>()

export async function runAutoBackups(engine: SyncEngine): Promise<void> {
  if (!getRemoteBackupsEnabled()) return
  if (_backupInProgress.has(engine)) return
  _backupInProgress.add(engine)
  try {
    const now = Date.now()
    for (const freq of ['hourly', 'daily', 'weekly'] as BackupFrequency[]) {
      const lastRun = parseInt(localStorage.getItem(BACKUP_LS_KEY(freq)) ?? '0', 10)
      if (now - lastRun >= AUTO_BACKUP_INTERVALS[freq] * 1000) {
        try {
          await engine.runBackup(freq)
          localStorage.setItem(BACKUP_LS_KEY(freq), String(now))
        } catch {
          // backup failures are non-fatal
        }
      }
    }
  } finally {
    _backupInProgress.delete(engine)
  }
}

export function resetEnsuredFolder(): void {
  forgetEnsuredFolders()
}

export interface SyncWebdavConfig {
  webdavUrl: string
  username: string
  appPassword: string
}

export function getSyncWebdavConfig(engine: SyncEngine | null): SyncWebdavConfig | null {
  const config = engine?.getConfig() as Record<string, unknown> | null
  if (!config?.enabled) return null
  // Support both generic WebDAV (webdavUrl) and Nextcloud (nextcloudUrl) provider shapes
  const webdavUrl = (config.webdavUrl ?? config.nextcloudUrl) as string | undefined
  const username = config.username as string | undefined
  const appPassword = config.appPassword as string | undefined
  if (!webdavUrl || !username || !appPassword) return null
  return { webdavUrl, username, appPassword }
}

export async function ensureSyncFolder(engine: SyncEngine): Promise<void> {
  const config = engine.getConfig() as Record<string, unknown> | null
  if (!config?.enabled || !config.webdavUrl) return
  const webdavUrl = config.webdavUrl as string
  const username = (config.username as string) ?? ''
  const appPassword = (config.appPassword as string) ?? ''
  if (!webdavUrl || !username) return
  // ensureFolder self-throttles via a persisted "folder exists" cache, so this
  // is safe to call on every sync trigger (reload, tab focus) without re-MKCOLing.
  try {
    const url = new URL(webdavUrl)
    const baseUrl = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
    const folder = localStorage.getItem(SYNC_FOLDER_KEY) || DEFAULT_SYNC_FOLDER
    await ensureFolder(baseUrl, folder, buildAuthHeader(username, appPassword))
  } catch {
    // non-fatal — if we can't create the folder the sync will surface its own error
  }
}

interface EngineCallbacks {
  onStatusChange: (status: SyncStatus) => void
  onError: (msg: string | null, code: SyncErrorCode | null, isHardStop: boolean) => void
  onLastSyncedChange: (iso: string) => void
  onPassphraseRequired: () => void
}

export function createEngine(proxyUrl: string | undefined, callbacks: EngineCallbacks): SyncEngine {
  const appFolderName = localStorage.getItem(SYNC_FOLDER_KEY) || DEFAULT_SYNC_FOLDER
  // If this device has never synced, seed the last-synced timestamp so the
  // engine skips the conflict-dialog path (which lastGLANCE doesn't implement)
  // and goes straight to the normal CRDT merge on first contact with the server.
  const KEY_LAST_SYNCED = 'lastglance-cloud-sync-last-synced'
  if (!localStorage.getItem(KEY_LAST_SYNCED)) {
    localStorage.setItem(KEY_LAST_SYNCED, new Date(Date.now() - 60_000).toISOString())
  }
  const engine = createSyncEngine({
    storageKeyPrefix: 'lastglance',
    cryptoDBName: 'lastglance-crypto',
    autoBackupDBName: 'lastglance-auto-backups',
    syncFilename: 'lastglance-sync.json',
    appFolderName,
    backupFilenamePrefix: 'lastglance-backup-',
    appId: 'lastglance',
    appName: 'lastGLANCE',
    proxyUrl,
    // On native (Capacitor) route WebDAV through the native HTTP stack so sync
    // works without the CORS proxy. In the browser use a direct fetch when
    // VITE_WEBDAV_DIRECT is enabled. Takes priority over proxyUrl in the engine,
    // so leaving it undefined keeps the proxy path.
    electronProxyFetch: isNativePlatform ? nativeHttpFetch : webdavDirect ? browserDirectFetch : undefined,
    buildPayload,
    buildBackupPayload: buildPayload,
    applyPayload,
    mergePayloads,
    onFirstSyncReload: () => {
      window.dispatchEvent(new CustomEvent('lg:sync-applied'))
      window.dispatchEvent(new CustomEvent('lg:chore-logged'))
    },
    ...callbacks,
  })

  // The generic webdav auto-backup provider targets the WebDAV root URL instead
  // of the sync folder's backups/ subdirectory. Patch it to match the nextcloud
  // provider and the dayGLANCE convention: {syncFolder}/backups/.
  const webdavBackup = engine.autoBackupProviders.webdav as unknown as Record<string, unknown>
  webdavBackup._getBackupDirUrl = (providerConfig: Record<string, string>) =>
    `${providerConfig.webdavUrl.replace(/\/+$/, '')}/${appFolderName}/backups/`

  return engine
}
