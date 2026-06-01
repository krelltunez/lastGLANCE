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
import { buildAuthHeader, ensureFolder } from '@/intents/webdav'
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
  for (const t of tombstoneRows) tombstones[t.id] = t.deleted_at

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
    completionEvents: completionEvents.map(e => ({
      id: e.sync_id,
      choreSyncId: choreMap.get(e.chore_id) ?? '',
      completedAt: e.completed_at,
      note: e.note,
      source: e.source,
      completedByUserSyncId: e.completed_by_user_sync_id ?? null,
    })),
    users: users.map(u => ({
      id: u.sync_id,
      name: u.name,
      updatedAt: u.updated_at,
    })),
    settings,
    tombstones,
  }
}

// mergePayloads: synchronous merge of local and remote payloads
export const mergePayloads = (
  local: unknown,
  remote: unknown,
): { data: unknown; localChanged: boolean; remoteChanged: boolean } => {
  const l = (local ?? { chores: [], categories: [], completionEvents: [], users: [], settings: { multiUserEnabled: false }, tombstones: {} }) as SyncPayload
  const r = (remote ?? { chores: [], categories: [], completionEvents: [], users: [], settings: { multiUserEnabled: false }, tombstones: {} }) as SyncPayload

  const allTombstones: Record<string, string> = { ...l.tombstones, ...r.tombstones }
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  const tombstones = pruneTombstones(allTombstones, cutoff)

  type R = Record<string, unknown>
  const catMerge = mergeArrayById(l.categories as unknown as R[] ?? [], r.categories as unknown as R[] ?? [], tombstones, null, { idField: 'id', timestampField: 'updatedAt' })
  const choreMerge = mergeArrayById(l.chores as unknown as R[] ?? [], r.chores as unknown as R[] ?? [], tombstones, null, { idField: 'id', timestampField: 'updatedAt' })
  const evtMerge = mergeArrayById(l.completionEvents as unknown as R[] ?? [], r.completionEvents as unknown as R[] ?? [], tombstones, null, { idField: 'id', timestampField: 'completedAt' })
  const userMerge = mergeArrayById(l.users as unknown as R[] ?? [], r.users as unknown as R[] ?? [], tombstones, null, { idField: 'id', timestampField: 'updatedAt' })

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
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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

// applyPayload: write merged data back to Dexie (two-pass for categories)
export const applyPayload = async (rawData: unknown, { allowEmpty }: { allowEmpty: boolean }): Promise<void> => {
  const data = rawData as SyncPayload
  if (!allowEmpty && !data?.chores?.length && !data?.categories?.length && !data?.completionEvents?.length && !data?.users?.length) return
  validateSyncPayload(data)

  // Apply synced settings to localStorage (device-local "me" is NOT overwritten)
  if (typeof data.settings?.multiUserEnabled === 'boolean') {
    setMultiUserEnabled(data.settings.multiUserEnabled)
  }

  await db.transaction('rw', db.categories, db.chores, db.completionEvents, db.tombstones, db.users, async () => {
    // ── CATEGORIES pass 1: upsert by sync_id ──
    for (const cat of (data.categories ?? [])) {
      if (data.tombstones?.[cat.id]) continue
      const existing = await db.categories.where('sync_id').equals(cat.id).first()
      if (existing) {
        await db.categories.update(existing.id, {
          name: cat.name,
          sort_order: cat.sortOrder,
          icon: cat.icon,
          parent_sync_id: cat.parentId,
          updated_at: cat.updatedAt,
        })
      } else {
        await db.categories.add({
          sync_id: cat.id,
          name: cat.name,
          sort_order: cat.sortOrder,
          icon: cat.icon,
          parent_sync_id: cat.parentId,
          parent_category_id: undefined,
          updated_at: cat.updatedAt,
        } as any)
      }
    }

    // ── CATEGORIES pass 2: resolve parent_sync_id → parent_category_id ──
    for (const cat of (data.categories ?? [])) {
      if (!cat.parentId || data.tombstones?.[cat.id]) continue
      const child = await db.categories.where('sync_id').equals(cat.id).first()
      if (!child) continue
      const parent = await db.categories.where('sync_id').equals(cat.parentId).first()
      if (parent) {
        await db.categories.update(child.id, { parent_category_id: parent.id })
      } else {
        // parent tombstoned — promote to root
        await db.categories.where('sync_id').equals(cat.id).modify((c: any) => {
          delete c.parent_category_id
          c.parent_sync_id = null
        })
      }
    }

    // ── Delete tombstoned categories ──
    for (const syncId of Object.keys(data.tombstones ?? {})) {
      const cat = await db.categories.where('sync_id').equals(syncId).first()
      if (cat) await db.categories.delete(cat.id)
    }

    // ── CHORES: upsert by sync_id ──
    for (const chore of (data.chores ?? [])) {
      if (data.tombstones?.[chore.id]) continue
      let category_id: number | undefined
      if (chore.categorySyncId) {
        const cat = await db.categories.where('sync_id').equals(chore.categorySyncId).first()
        category_id = cat?.id
      }
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
        if (!category_id) continue  // category was deleted; skip rather than store category_id: 0
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
        } as any)
      }
    }

    // ── Delete tombstoned chores ──
    for (const syncId of Object.keys(data.tombstones ?? {})) {
      const chore = await db.chores.where('sync_id').equals(syncId).first()
      if (chore) await db.chores.delete(chore.id)
    }

    // ── COMPLETION EVENTS: upsert by sync_id ──
    for (const evt of (data.completionEvents ?? [])) {
      if (data.tombstones?.[evt.id]) continue
      const existing = await db.completionEvents.where('sync_id').equals(evt.id).first()
      if (existing) continue  // events are immutable; skip if already present
      const chore = await db.chores.where('sync_id').equals(evt.choreSyncId).first()
      if (!chore) continue  // chore was deleted; skip orphaned events
      await db.completionEvents.add({
        sync_id: evt.id,
        chore_id: chore.id!,
        completed_at: evt.completedAt,
        note: evt.note,
        source: evt.source,
        completed_by_user_sync_id: evt.completedByUserSyncId ?? null,
      } as any)
    }

    // ── Delete tombstoned completion events ──
    for (const syncId of Object.keys(data.tombstones ?? {})) {
      const evt = await db.completionEvents.where('sync_id').equals(syncId).first()
      if (evt) await db.completionEvents.delete(evt.id!)
    }

    // ── USERS: upsert by sync_id ──
    for (const user of (data.users ?? [])) {
      if (data.tombstones?.[user.id]) continue
      const existing = await db.users.where('sync_id').equals(user.id).first()
      if (existing) {
        await db.users.update(existing.id, {
          name: user.name,
          updated_at: user.updatedAt,
        })
      } else {
        await db.users.add({
          sync_id: user.id,
          name: user.name,
          updated_at: user.updatedAt,
        } as any)
      }
    }

    // ── Delete tombstoned users ──
    for (const syncId of Object.keys(data.tombstones ?? {})) {
      const user = await db.users.where('sync_id').equals(syncId).first()
      if (user) await db.users.delete(user.id)
    }

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

let _ensuredForUrl = ''

export function resetEnsuredFolder(): void {
  _ensuredForUrl = ''
}

export async function ensureSyncFolder(engine: SyncEngine): Promise<void> {
  const config = engine.getConfig() as Record<string, unknown> | null
  if (!config?.enabled || !config.webdavUrl) return
  const webdavUrl = config.webdavUrl as string
  const username = (config.username as string) ?? ''
  const appPassword = (config.appPassword as string) ?? ''
  if (!webdavUrl || !username) return
  // Only run MKCOL once per unique folder URL to avoid flooding the server
  if (_ensuredForUrl === webdavUrl) return
  try {
    const url = new URL(webdavUrl)
    const baseUrl = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
    const folder = localStorage.getItem(SYNC_FOLDER_KEY) || DEFAULT_SYNC_FOLDER
    await ensureFolder(baseUrl, folder, buildAuthHeader(username, appPassword))
    _ensuredForUrl = webdavUrl
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
