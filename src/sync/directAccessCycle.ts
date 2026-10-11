// One Direct Access cycle: `@glance-apps/sync`'s runSnapshotFileCycle with
// lastGLANCE's seams filled in. Nothing here touches React; the hook
// (hooks/useDirectAccessSync.ts) owns the poll, the in-flight guard and the
// prompts.
//
// The cycle (the seed guard, the content gate, the made-here-or-relayed rule
// with staggered relays, the envelope rules) is the package's and shared with
// dayGLANCE; the spec is its docs/SYNC_PACKAGE_SPEC.md, "Snapshot-File Cycle".
// What is this app's, and supplied here:
//
//   • the payload: buildPayload reads Dexie, so it is built BEFORE the cycle
//     and handed in as the synchronous thunk the package calls; the same data
//     stands for "local" throughout one cycle;
//   • the apply: applyPayload is async and the package does not await it, so
//     the promise is captured and awaited after the cycle, and the in-flight
//     guard stays up until it settles;
//   • the two device-local stamps: the WebDAV engine's local-modified key, so
//     a change that arrived through the folder is pushed on by WebDAV too, and
//     the local-edit stamp (localEditStamp.ts) that tells a change made here
//     from one to relay;
//   • what counts as data: chores, categories and completion events;
//   • the empty-state guard is moot: the payload IS the store (Dexie), so a
//     payload of nothing means a store of nothing, and `localItemCount` is
//     left at its default of zero.

import {
  runSnapshotFileCycle,
  isEncryptedEnvelope,
  decryptData,
  encryptData,
  hasEncryptionReady,
  getSyncPassphrase,
} from '@glance-apps/sync'
import type { SnapshotFileOutcome, SnapshotFileState, SnapshotFileTransport } from '@glance-apps/sync'
import { buildPayload as defaultBuildPayload, applyPayload as defaultApplyPayload, mergePayloads as defaultMergePayloads, CRYPTO_CONFIG } from './engine'
import { lastLocalEditAt as defaultLastLocalEditAt } from './localEditStamp'
import { getDeviceId } from './deviceId'
import type { SyncPayload } from './types'

/** Shared with the WebDAV engine (`${storageKeyPrefix}-cloud-sync-local-modified`): when this device last changed synced data. */
export const LOCAL_MODIFIED_KEY = 'lastglance-cloud-sync-local-modified'
/** The merge's tombstone horizon, as mergePayloads applies it. */
export const SYNC_RETENTION_DAYS = 90
/** The data version the WebDAV file carries (ENVELOPE_DATA_VERSION); the snapshot header says the same. */
export const SNAPSHOT_DATA_VERSION = 2

export type Payload = Record<string, unknown>

/** Does a payload carry anything worth restoring: chores, categories or completion events. */
export function payloadHasData(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const d = data as Partial<SyncPayload>
  const n = (v: unknown) => (Array.isArray(v) ? v.length : 0)
  return n(d.chores) + n(d.categories) + n(d.completionEvents) > 0
}

export interface DirectAccessCycleDeps {
  transport: SnapshotFileTransport & { isEnabled?: () => boolean }
  buildPayload?: () => Promise<SyncPayload>
  applyPayload?: (data: unknown, opts: { allowEmpty: boolean }) => Promise<void>
  mergePayloads?: (local: unknown, remote: unknown) => { data: unknown; localChanged: boolean; remoteChanged: boolean }
  crypto?: {
    isEncryptedEnvelope: (v: unknown) => boolean
    decryptData: (envelope: unknown) => Promise<unknown>
    encryptData: (payload: unknown) => Promise<unknown>
    encryptionReady: () => boolean
  }
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  lastLocalEditAt?: () => string | null
  deviceId?: () => string
  now?: () => number
  log?: Pick<Console, 'warn' | 'error'>
}

const defaultCrypto: NonNullable<DirectAccessCycleDeps['crypto']> = {
  isEncryptedEnvelope,
  decryptData: (envelope) => decryptData(envelope as Parameters<typeof decryptData>[0], CRYPTO_CONFIG),
  encryptData: (payload) => encryptData(payload, CRYPTO_CONFIG),
  // encryptData derives the key lazily from a passphrase in memory.
  encryptionReady: () => hasEncryptionReady() || !!getSyncPassphrase(),
}

export async function runDirectAccessCycle(
  deps: DirectAccessCycleDeps,
  state: SnapshotFileState | null | undefined,
): Promise<{ state: Required<SnapshotFileState>; outcome: SnapshotFileOutcome }> {
  const {
    transport,
    buildPayload = defaultBuildPayload,
    applyPayload = defaultApplyPayload,
    mergePayloads = defaultMergePayloads,
    crypto = defaultCrypto,
    storage = localStorage,
    lastLocalEditAt = defaultLastLocalEditAt,
    deviceId = getDeviceId,
    now,
    log,
  } = deps

  const data = (await buildPayload()) as unknown as Payload
  let applied: Promise<void> | null = null

  const result = await runSnapshotFileCycle({
    transport,
    io: {
      buildSyncPayload: () => ({ version: SNAPSHOT_DATA_VERSION, lastModified: new Date((now ?? Date.now)()).toISOString(), data }),
      applyEngineData: (merged, opts) => { applied = applyPayload(merged, opts) },
      mergeSyncData: (local, remote) => {
        const r = mergePayloads(local, remote)
        return { data: r.data as Payload, localChanged: r.localChanged, remoteChanged: r.remoteChanged }
      },
      syncRetentionDays: SYNC_RETENTION_DAYS,
      isEncryptedEnvelope: crypto.isEncryptedEnvelope,
      decryptData: (envelope) => crypto.decryptData(envelope) as Promise<Payload>,
      encryptData: (payload) => crypto.encryptData(payload) as Promise<Payload>,
      encryptionReady: crypto.encryptionReady,
      storage,
      lastLocalEditAt,
      localModifiedKey: LOCAL_MODIFIED_KEY,
      hasData: payloadHasData,
      deviceId,
      ...(now ? { now } : {}),
      ...(log ? { log } : {}),
    },
    state,
  })
  if (applied) await applied
  return result
}
