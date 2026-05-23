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
import type { SyncPayload } from './types'

export const CRYPTO_CONFIG = { cryptoDBName: 'lastglance-crypto' }

export { initSessionKey, setupEncryptionKey, clearEncryptionKey }

// buildPayload: read all Dexie tables, map to sync shapes
export const buildPayload = async (): Promise<SyncPayload> => {
  const [categories, chores, completionEvents, tombstoneRows] = await Promise.all([
    db.categories.toArray(),
    db.chores.toArray(),
    db.completionEvents.toArray(),
    db.tombstones.toArray(),
  ])

  const tombstones: Record<string, string> = {}
  for (const t of tombstoneRows) tombstones[t.id] = t.deleted_at

  const choreMap = new Map(chores.map(c => [c.id!, c.sync_id]))

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
      icon: c.icon,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    })),
    completionEvents: completionEvents.map(e => ({
      id: e.sync_id,
      choreSyncId: choreMap.get(e.chore_id) ?? '',
      completedAt: e.completed_at,
      note: e.note,
      source: e.source,
    })),
    tombstones,
  }
}

// mergePayloads: synchronous merge of local and remote payloads
export const mergePayloads = (
  local: unknown,
  remote: unknown,
): { data: unknown; localChanged: boolean; remoteChanged: boolean } => {
  const l = (local ?? { chores: [], categories: [], completionEvents: [], tombstones: {} }) as SyncPayload
  const r = (remote ?? { chores: [], categories: [], completionEvents: [], tombstones: {} }) as SyncPayload

  const allTombstones: Record<string, string> = { ...l.tombstones, ...r.tombstones }
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  const tombstones = pruneTombstones(allTombstones, cutoff)

  type R = Record<string, unknown>
  const catMerge = mergeArrayById(l.categories as unknown as R[] ?? [], r.categories as unknown as R[] ?? [], tombstones, null, { idField: 'id', timestampField: 'updatedAt' })
  const choreMerge = mergeArrayById(l.chores as unknown as R[] ?? [], r.chores as unknown as R[] ?? [], tombstones, null, { idField: 'id', timestampField: 'updatedAt' })
  const evtMerge = mergeArrayById(l.completionEvents as unknown as R[] ?? [], r.completionEvents as unknown as R[] ?? [], tombstones, null, { idField: 'id', timestampField: 'completedAt' })

  return {
    data: {
      categories: catMerge.merged,
      chores: choreMerge.merged,
      completionEvents: evtMerge.merged,
      tombstones,
    } as unknown as SyncPayload,
    localChanged: catMerge.localChanged || choreMerge.localChanged || evtMerge.localChanged,
    remoteChanged: catMerge.remoteChanged || choreMerge.remoteChanged || evtMerge.remoteChanged,
  }
}

// applyPayload: write merged data back to Dexie (two-pass for categories)
export const applyPayload = async (rawData: unknown, { allowEmpty }: { allowEmpty: boolean }): Promise<void> => {
  const data = rawData as SyncPayload
  if (!allowEmpty && !data?.chores?.length && !data?.categories?.length && !data?.completionEvents?.length) return

  await db.transaction('rw', db.categories, db.chores, db.completionEvents, db.tombstones, async () => {
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
          icon: chore.icon,
          updated_at: chore.updatedAt,
        })
      } else {
        await db.chores.add({
          sync_id: chore.id,
          name: chore.name,
          category_id: category_id ?? 0,
          category_sync_id: chore.categorySyncId,
          sort_order: chore.sortOrder,
          target_cadence_days: chore.targetCadenceDays,
          notify_when_overdue: chore.notifyWhenOverdue,
          auto_schedule_to_dayglance: chore.autoScheduleToDayglance,
          preferred_schedule_behavior: chore.preferredScheduleBehavior,
          icon: chore.icon,
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
      } as any)
    }

    // ── Delete tombstoned completion events ──
    for (const syncId of Object.keys(data.tombstones ?? {})) {
      const evt = await db.completionEvents.where('sync_id').equals(syncId).first()
      if (evt) await db.completionEvents.delete(evt.id!)
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

export async function runAutoBackups(engine: SyncEngine): Promise<void> {
  if (!getRemoteBackupsEnabled()) return
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
}

export async function ensureSyncFolder(engine: SyncEngine): Promise<void> {
  const config = engine.getConfig() as Record<string, unknown> | null
  if (!config?.enabled || !config.webdavUrl) return
  const webdavUrl = config.webdavUrl as string
  const username = (config.username as string) ?? ''
  const appPassword = (config.appPassword as string) ?? ''
  if (!webdavUrl || !username) return
  try {
    const url = new URL(webdavUrl)
    const baseUrl = `${url.protocol}//${url.host}`
    const folderPath = url.pathname.replace(/^\//, '').replace(/\/+$/, '')
    await ensureFolder(baseUrl, folderPath, buildAuthHeader(username, appPassword))
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
  return createSyncEngine({
    storageKeyPrefix: 'lastglance',
    cryptoDBName: 'lastglance-crypto',
    autoBackupDBName: 'lastglance-auto-backups',
    syncFilename: 'lastglance-sync.json',
    appFolderName: 'lastglance',
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
}
