// People vault sync: the lastglance-people app on GLANCEvault, separate from
// the lastglance app the chore engine syncs.
//
// A separate app keeps People rows away from older builds entirely. Their
// chore engine guesses a row's type from its fields (entityKind in
// src/sync/dbEngine.ts) and treats anything with a `name` and no other marker
// as a household user, so a person row in the lastglance app would turn into a
// phantom member there.
//
// The vault keys device cursors by account + device, not by app, so this
// engine reports its own device id; its own storageKeyPrefix keeps the local
// pull cursor and dirty set independent of the chore engine. The salt is per
// account, so the same passphrase and root key work unchanged.
//
// A vault server that predates the lastglance-people app answers 400 "unknown
// app". The engine then stands down and People keep syncing through the file
// road; the flag clears on the next app start so an updated server is picked up.

import { createDbSyncEngine } from '@glance-apps/sync'
import type { DbSyncEngine, DbSyncResult, SyncErrorCode, SyncStatus } from '@glance-apps/sync'
import { db } from '@/db/client'
import { getVaultConfig, isVaultEnabled } from '@/sync/vaultConfig'
import { getDeviceId } from '@/sync/deviceId'
import { DB_ROOT_KEY_HOOKS } from '@/sync/nativeKeyHooks'
import { headlessFetchImpl } from '@/headless/headlessHttp'
import { isPeopleVaultSyncEnabled } from '../vaultSync'
import { deletePeopleRow, getLocalPeopleEntity, notifyPeopleApplied, upsertPeopleEntity } from './apply'
import type { SyncPeopleEntity } from './types'
import { cycleWithLauncherRepair, markChangedSince } from '@/sync/launcherWritesRepair'

export const PEOPLE_VAULT_APP = 'lastglance-people'
const SEEDED_FLAG = `${PEOPLE_VAULT_APP}-db-sync-snapshot-seeded`
// The re-push of rows headless refreshes saved unmarked (src/sync/launcherWritesRepair.ts).
const LAUNCHER_REPAIR_FLAG = `${PEOPLE_VAULT_APP}-db-sync-launcher-writes-repaired`

export function peopleDeviceId(): string {
  return `${getDeviceId()}-people`
}

const KINDS = new Set(['person', 'interaction', 'personDate', 'personCircle'])

export function isPeopleEntity(entity: unknown): entity is SyncPeopleEntity {
  return !!entity && typeof entity === 'object' && KINDS.has((entity as { kind?: string }).kind ?? '')
}

export async function applyRemotePeopleEntity(_entityId: string, entity: unknown): Promise<void> {
  if (!isPeopleEntity(entity)) return
  if (await upsertPeopleEntity(entity)) notifyPeopleApplied()
}

export async function applyRemotePeopleDelete(entityId: string): Promise<void> {
  const deletedAt = new Date().toISOString()
  await db.transaction('rw', [db.people, db.interactions, db.personDates, db.personCircles, db.peopleTombstones], async () => {
    await db.peopleTombstones.put({ id: entityId, deleted_at: deletedAt })
    await deletePeopleRow(entityId, deletedAt)
  })
  notifyPeopleApplied()
}

export function getPeopleEntityLastModified(entity: unknown): string | undefined {
  return isPeopleEntity(entity) ? entity.updatedAt : undefined
}

// True when an error is the vault refusing the app name: a server that has not
// been updated to know lastglance-people answers 400 "unknown app". The sync
// client keeps only the status in its message ("list failed: 400"), and every
// other 400 cause (a missing account id) is caught client-side before the
// wire, so a 400 on this app means the server does not know it.
export function isUnknownAppError(message: string | null | undefined): boolean {
  return !!message && (/unknown app/i.test(message) || /failed: 400\b/.test(message))
}

export interface PeopleDbEngineCallbacks {
  onStatusChange?: (status: SyncStatus) => void
  onError?: (message: string | null, code: SyncErrorCode | null) => void
  // The vault does not know lastglance-people yet; People stay on file sync.
  onUnsupported?: () => void
}

async function markAllPeopleDirty(engine: DbSyncEngine): Promise<void> {
  const [people, interactions, dates, circles] = await Promise.all([
    db.people.toArray(), db.interactions.toArray(), db.personDates.toArray(), db.personCircles.toArray(),
  ])
  for (const row of [...people, ...interactions, ...dates, ...circles]) engine.markDirty(row.sync_id)
}

export async function markPeopleLauncherRepairDirty(engine: DbSyncEngine): Promise<number> {
  const [people, interactions, dates, circles] = await Promise.all([
    db.people.toArray(), db.interactions.toArray(), db.personDates.toArray(), db.personCircles.toArray(),
  ])
  return markChangedSince(engine, [...people, ...interactions, ...dates, ...circles])
}

// Returns null when the vault is off or the user keeps People off the vault.
export function createPeopleDbEngine(callbacks: PeopleDbEngineCallbacks = {}): DbSyncEngine | null {
  if (!isVaultEnabled() || !isPeopleVaultSyncEnabled()) return null
  const cfg = getVaultConfig()!
  let unsupported = false

  const engine = createDbSyncEngine({
    storageKeyPrefix: PEOPLE_VAULT_APP,
    appId: PEOPLE_VAULT_APP,
    vaultApp: PEOPLE_VAULT_APP,
    cryptoDBName: 'lastglance-crypto',
    ...DB_ROOT_KEY_HOOKS,
    vaultUrl: cfg.vaultUrl,
    vaultToken: cfg.vaultToken,
    // A headless refresh has no CapacitorHttp; the shell's HTTP stands in.
    fetchImpl: headlessFetchImpl(),
    accountId: cfg.accountId,
    deviceId: peopleDeviceId(),
    getLocalEntity: getLocalPeopleEntity,
    applyRemoteEntity: applyRemotePeopleEntity,
    applyRemoteDelete: applyRemotePeopleDelete,
    // Interactions are editable (note, people, time), so nothing is insert-only.
    isInsertOnly: () => false,
    getEntityLastModified: getPeopleEntityLastModified,
    pullCursorCommit: 'per-page',
    onStatusChange: callbacks.onStatusChange,
    onError: (message, code) => {
      if (isUnknownAppError(message)) {
        if (!unsupported) {
          unsupported = true
          callbacks.onUnsupported?.()
        }
        return
      }
      callbacks.onError?.(message, code)
    },
  })

  // First sync on this device: push the whole local People set once, then
  // latch, like the chore engine's one-shot seed (src/sync/dbEngine.ts).
  const runCycle = engine.dbSyncCycle.bind(engine)
  const dbSyncCycle = async (): Promise<DbSyncResult> => {
    if (unsupported) return { applied: 0, skipped: 0, skippedEntityIds: [] } as unknown as DbSyncResult
    if (localStorage.getItem(SEEDED_FLAG) !== '1') {
      if (engine.getHighWaterMark() > 0) {
        localStorage.setItem(SEEDED_FLAG, '1')
      } else {
        try {
          await markAllPeopleDirty(engine)
          localStorage.setItem(SEEDED_FLAG, '1')
        } catch (err) {
          console.warn('[lastglance] people vault initial snapshot failed:', err)
        }
      }
    }
    return cycleWithLauncherRepair(engine, runCycle, LAUNCHER_REPAIR_FLAG, () => markPeopleLauncherRepairDirty(engine))
  }

  return { ...engine, dbSyncCycle, sync: dbSyncCycle }
}
