// Zero-config iCloud sync (docs/icloud-sync.md), dayGLANCE's iCloud tier
// (src/sync/icloudSnapshotTransport.js, src/utils/icloudSyncPref.js) over this
// app's shared cycle: lastglance-sync.json and lastglance-people.json in the
// app's own iCloud container, run by the same hook and the same two cycles as
// Direct Access (hooks/useSnapshotFileSync.ts, sync/directAccessCycle.ts,
// people/sync/directAccessCycle.ts). What is iCloud's here:
//
//   • ON by default on iOS, with nothing to set up, and a per-device switch.
//     The preference is tri-state (absent = on, 'true', 'false') because a
//     reinstall turns iOS's per-app iCloud toggle back on while the container
//     file survives: a fresh install that finds cloud data and holds none of
//     its own is asked before anything is restored (firstRunDecided), and the
//     answer is what the switch then shows.
//   • Plaintext. iCloud Drive is encrypted by Apple at rest and in transit,
//     so the encrypt switch does not apply, and an envelope a file somehow
//     holds is decrypted once with the cached key and written back plain
//     (`allowsPlaintextReseed`).
//   • A download that stalls past ICLOUD_DOWNLOAD_GRACE_MS is read from the
//     last downloaded copy, so this device's edits are not held hostage
//     (on 2026-10-05 a phone's were held for twelve minutes in dayGLANCE).
//   • "Real data" leaves out the sample chores a fresh install seeds (they
//     have fixed ids and an old stamp, isPristineSeedRow), or a fresh install
//     would never count as empty and the first-run question would never come.

import { icloudBridge, type ICloudBridge } from '@/native/icloud'
import { isPristineSeedRow } from '@/db/client'
import type { DirectAccessRead } from '@/native/directAccess'

export const ICLOUD_POLL_MS = 15 * 1000
/** The daemon's round trip takes ~5-10 s; writing faster piles up conflict versions. */
export const ICLOUD_WRITE_THROTTLE_MS = 5 * 1000
export const ICLOUD_DOWNLOAD_GRACE_MS = 2 * 60 * 1000
export const ICLOUD_SYNC_FILE = 'lastglance-sync.json'
export const ICLOUD_PEOPLE_FILE = 'lastglance-people.json'
export const ICLOUD_LAST_SYNCED_KEY = 'lastglance-icloud-last-synced'
export const ICLOUD_PEOPLE_LAST_SYNCED_KEY = 'lastglance-icloud-people-last-synced'
/** 'true' | 'false' | absent. Absent means ON and the first-run question not yet answered. */
export const ICLOUD_SYNC_PREF_KEY = 'lastglance-icloud-sync-enabled'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const defaultStorage = (): StorageLike | null => (typeof localStorage === 'undefined' ? null : localStorage)

/** The raw decision: null when the user has not chosen. */
export function getICloudSyncPref(storage: () => StorageLike | null = defaultStorage): 'true' | 'false' | null {
  try {
    const v = storage()?.getItem(ICLOUD_SYNC_PREF_KEY) ?? null
    return v === 'true' || v === 'false' ? v : null
  } catch { return null }
}

/** Absence is ON: zero-config is the default and must stay it. */
export function isICloudSyncEnabled(storage: () => StorageLike | null = defaultStorage): boolean {
  return getICloudSyncPref(storage) !== 'false'
}

/** Records the decision; recording true also marks the first-run question answered. */
export function setICloudSyncEnabled(enabled: boolean, storage: () => StorageLike | null = defaultStorage): void {
  try { storage()?.setItem(ICLOUD_SYNC_PREF_KEY, enabled ? 'true' : 'false') } catch { /* this session still follows it */ }
}

const count = (v: unknown, keep: (row: never) => boolean = () => true) =>
  (Array.isArray(v) ? (v as never[]).filter(keep).length : 0)
const notSeed = (row: never) => !isPristineSeedRow(row as { id?: unknown; updatedAt?: unknown })

/** Chores the user made or touched, categories likewise, and any completion. */
export function choresHaveRealData(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return count(d.chores, notSeed) + count(d.categories, notSeed) + count(d.completionEvents) > 0
}

/** How many chores a payload carries, sample chores left out: the first-run question's figure. */
export function realChoreCount(data: unknown): number {
  return data && typeof data === 'object' ? count((data as Record<string, unknown>).chores, notSeed) : 0
}

export interface ICloudTransportDeps {
  bridge?: () => ICloudBridge | null
  storage?: () => StorageLike | null
  now?: () => number
  downloadGraceMs?: number
  log?: Pick<Console, 'warn'>
}

/** The download sentinel the shared cycle reads (classifySnapshotText). */
const readToText = (r: DirectAccessRead): string | null => {
  switch (r.kind) {
    case 'absent': return null
    case 'downloading': return JSON.stringify({ downloading: true })
    case 'text': return r.text ?? ''
    default: return JSON.stringify({ error: r.error ?? 'iCloud unavailable' })
  }
}

export function createICloudTransport({
  bridge = icloudBridge,
  storage = defaultStorage,
  now = Date.now,
  downloadGraceMs = ICLOUD_DOWNLOAD_GRACE_MS,
  log = console,
}: ICloudTransportDeps = {}) {
  const isEnabled = () => isICloudSyncEnabled(storage)

  // Re-probed every cycle rather than cached: iCloud Drive switched off
  // mid-session must go quiet, and come back by itself when it returns.
  const isAvailable = async (): Promise<boolean> => {
    const b = bridge()
    return !!b && isEnabled() && (await b.available())
  }

  // One snapshot file of the own container, with its own download clock.
  const file = (path: string, lastSyncedKey: string, id: string) => {
    let downloadingSince: number | null = null
    return {
      id,
      pollMs: ICLOUD_POLL_MS,
      writeThrottleMs: ICLOUD_WRITE_THROTTLE_MS,
      lastSyncedKey,
      allowsPlaintextReseed: true,
      encryptsWrites: () => false,
      firstRunDecided: () => getICloudSyncPref(storage) !== null,
      isAvailable,
      read: async (): Promise<string | null> => {
        const b = bridge()
        if (!b) return JSON.stringify({ error: 'no iCloud' })
        const fresh = await b.read(path)
        if (fresh.kind !== 'downloading') { downloadingSince = null; return readToText(fresh) }
        const t = now()
        if (downloadingSince === null) downloadingSince = t
        if (t - downloadingSince < downloadGraceMs) return readToText(fresh)
        // Stalled past the window: merge into the last downloaded copy, if any.
        const stale = await b.read(path, { allowStale: true })
        if (stale.kind !== 'text') return readToText(fresh)
        log.warn(`[icloud] ${path}: download stalled ${Math.round((t - downloadingSince) / 1000)} s; merging into the last downloaded copy`)
        return readToText(stale)
      },
      write: async (text: string): Promise<boolean> => (await bridge()?.write(path, text, { atomic: true })) === true,
    }
  }

  const choresFile = file(ICLOUD_SYNC_FILE, ICLOUD_LAST_SYNCED_KEY, 'icloud')
  return {
    ...choresFile,
    peopleFile: file(ICLOUD_PEOPLE_FILE, ICLOUD_PEOPLE_LAST_SYNCED_KEY, 'icloud-people'),
    isSupported: () => !!bridge(),
    isEnabled,
    setEnabled: (enabled: boolean) => setICloudSyncEnabled(enabled, storage),
    onChanged: (cb: () => void): (() => void) => bridge()?.onChanged(cb) ?? (() => {}),
  }
}

export type ICloudTransport = ReturnType<typeof createICloudTransport>

/** The app's one iCloud transport. */
export const icloudTransport: ICloudTransport = createICloudTransport()
