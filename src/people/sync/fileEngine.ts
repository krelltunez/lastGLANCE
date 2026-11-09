// People file sync: a second WebDAV file, lastglance-people.json, next to
// lastglance-sync.json in the same folder and under the same encryption key.
//
// Why a second file and not a `people` array in the chore payload: the chore
// engine's mergePayloads rebuilds the payload from the arrays it knows, so a
// device still on an older build would merge and upload a file with People
// silently dropped. Older builds never open this file.
//
// The engine instance has its own localStorage prefix (lastglance-people) so
// its last-synced and backoff state stay independent, but the user configures
// sync once: syncPeopleFileConfig mirrors the chore engine's provider config
// into it before every cycle.

import { createSyncEngine, mergeArrayById, pruneTombstones } from '@glance-apps/sync'
import type { SyncEngine, SyncErrorCode, SyncStatus } from '@glance-apps/sync'
import { db } from '@/db/client'
import { browserDirectFetch, isNativePlatform, nativeHttpFetch, webdavDirect } from '@/sync/nativeHttp'
import { FILE_SYNC_KEY_HOOKS } from '@/sync/nativeKeyHooks'
import { getSyncFolder } from '@/sync/syncFolder'
import { buildPeoplePayload, deletePeopleRow, notifyPeopleApplied, PEOPLE_TABLES, upsertPeopleEntity } from './apply'
import { emptyPeoplePayload, invalidReason, uuidRe } from './types'
import type { PeoplePayload, SyncPeopleEntity } from './types'

export const PEOPLE_SYNC_FILENAME = 'lastglance-people.json'
const PREFIX = 'lastglance-people'
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000

// Lives in ./apply so the backup code can read People without loading the
// sync engine; re-exported here for the file roads that already import it.
export { buildPeoplePayload }

type R = Record<string, unknown>
const ARRAYS = ['people', 'interactions', 'personDates', 'personCircles'] as const

function cleanArray(items: unknown): R[] {
  if (!Array.isArray(items)) return []
  const byId = new Map<string, R>()
  for (const item of items as SyncPeopleEntity[]) {
    if (invalidReason(item)) continue
    const prev = byId.get(item.id)
    if (!prev || String(item.updatedAt) > String(prev.updatedAt)) byId.set(item.id, item as unknown as R)
  }
  return [...byId.values()]
}

export const mergePeoplePayloads = (
  local: unknown,
  remote: unknown,
): { data: unknown; localChanged: boolean; remoteChanged: boolean } => {
  const l = (local ?? emptyPeoplePayload()) as Partial<PeoplePayload>
  const r = (remote ?? emptyPeoplePayload()) as Partial<PeoplePayload>

  const all: Record<string, string> = {}
  for (const [k, v] of Object.entries({ ...(l.tombstones ?? {}), ...(r.tombstones ?? {}) })) {
    // Two devices may tombstone the same id; keep the later stamp.
    if (uuidRe.test(k) && (!all[k] || v > all[k])) all[k] = v
  }
  const tombstones = pruneTombstones(all, new Date(Date.now() - TOMBSTONE_TTL_MS))

  const data = { ...emptyPeoplePayload(), tombstones } as unknown as Record<string, unknown>
  let localChanged = false
  let remoteChanged = false
  for (const key of ARRAYS) {
    const m = mergeArrayById(cleanArray(l[key]), cleanArray(r[key]), tombstones, null, { idField: 'id', timestampField: 'updatedAt' })
    data[key] = m.merged
    localChanged ||= m.localChanged
    remoteChanged ||= m.remoteChanged
  }
  return { data, localChanged, remoteChanged }
}

// Writes a payload into Dexie: upserts live rows under last-writer-wins and
// removes local rows a newer tombstone covers. Invalid rows are dropped one by
// one instead of failing the whole apply.
export const applyPeoplePayload = async (rawData: unknown, { allowEmpty }: { allowEmpty: boolean }): Promise<void> => {
  const data = (rawData ?? {}) as Partial<PeoplePayload>
  const isEmpty = ARRAYS.every(k => !(data[k]?.length))
  if (!allowEmpty && isEmpty) return

  const tombstones: Record<string, string> = {}
  for (const [k, v] of Object.entries(data.tombstones ?? {})) {
    if (uuidRe.test(k) && typeof v === 'string') tombstones[k] = v
  }
  const live = new Set<string>()

  await db.transaction('rw', PEOPLE_TABLES(), async () => {
    for (const key of ARRAYS) {
      for (const e of (data[key] ?? []) as SyncPeopleEntity[]) {
        const deletedAt = tombstones[e?.id]
        if (deletedAt && Date.parse(deletedAt) > Date.parse(e.updatedAt)) continue
        live.add(e.id)
        await upsertPeopleEntity(e)
      }
    }
    for (const [id, deletedAt] of Object.entries(tombstones)) {
      if (!live.has(id)) await deletePeopleRow(id, deletedAt)
    }
    await db.peopleTombstones.bulkPut(Object.entries(tombstones).map(([id, deleted_at]) => ({ id, deleted_at })))
  })

  notifyPeopleApplied()
}

// Copies the chore engine's provider config into the People engine when it
// differs, so one Cloud Sync setup drives both files. Turning chore sync off
// turns People file sync off with it.
export function syncPeopleFileConfig(main: SyncEngine, people: SyncEngine): void {
  const mainCfg = main.getConfig()
  if (JSON.stringify(mainCfg ?? null) !== JSON.stringify(people.getConfig() ?? null)) {
    people.setConfig(mainCfg ?? null)
  }
}

interface PeopleFileCallbacks {
  onStatusChange?: (status: SyncStatus) => void
  onError?: (msg: string | null, code: SyncErrorCode | null, isHardStop: boolean) => void
}

export function createPeopleFileEngine(
  proxyUrl: string | undefined,
  main: SyncEngine,
  callbacks: PeopleFileCallbacks = {},
): SyncEngine {
  // Same first-contact seeding as the chore engine (src/sync/engine.ts): skip
  // the conflict-dialog path lastGLANCE doesn't implement and merge directly.
  const KEY_LAST_SYNCED = `${PREFIX}-cloud-sync-last-synced`
  if (!localStorage.getItem(KEY_LAST_SYNCED)) {
    localStorage.setItem(KEY_LAST_SYNCED, new Date(Date.now() - 60_000).toISOString())
  }
  const appFolderName = getSyncFolder()
  const engine = createSyncEngine({
    storageKeyPrefix: PREFIX,
    cryptoDBName: 'lastglance-crypto',
    ...FILE_SYNC_KEY_HOOKS,
    autoBackupDBName: 'lastglance-people-auto-backups',
    syncFilename: PEOPLE_SYNC_FILENAME,
    appFolderName,
    backupFilenamePrefix: 'lastglance-people-backup-',
    appId: PREFIX,
    appName: 'lastGLANCE People',
    proxyUrl,
    electronProxyFetch: isNativePlatform ? nativeHttpFetch : webdavDirect ? browserDirectFetch : undefined,
    buildPayload: buildPeoplePayload,
    buildBackupPayload: buildPeoplePayload,
    applyPayload: applyPeoplePayload,
    mergePayloads: mergePeoplePayloads,
    onFirstSyncReload: notifyPeopleApplied,
    onStatusChange: callbacks.onStatusChange ?? (() => {}),
    onError: callbacks.onError ?? ((msg) => { if (msg) console.warn('[lastglance] people file sync:', msg) }),
    onLastSyncedChange: () => {},
    // The chore engine owns the passphrase prompt; a People cycle that finds no
    // key simply waits for the next one.
    onPassphraseRequired: () => {},
  })

  const sync = async () => {
    syncPeopleFileConfig(main, engine)
    if (!engine.getConfig()?.enabled) return
    return engine.sync()
  }
  return { ...engine, sync, download: sync }
}
