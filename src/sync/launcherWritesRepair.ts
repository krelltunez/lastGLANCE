// A one-time re-push of what headless refreshes saved without a vault mark.
//
// From lastGLANCE 2.13.0 (26 October 2026) a headless refresh applied the
// launcher's queued writes, but it never registered its vault engines with the
// dirty trackers, so the data layer's markDirty found no engine and the rows
// were saved locally and never pushed. The run's file roads diff whole payloads
// and carried them; the vault, which pushes only marked rows, never would. The
// run now registers its engines (src/headless/headlessRefresh.ts). Which rows
// came from the launcher is not recorded, so this re-marks every row changed
// since then, once per engine, right after a fully successful cycle: lastSynced
// only advances when both the push and the pull landed, so every row the vault
// already had now matches it locally, and re-pushing those is a no-op upsert.

import type { DbSyncEngine, DbSyncResult } from '@glance-apps/sync'
import { isPristineSeed } from '@/db/client'

export const LAUNCHER_REPAIR_SINCE = '2026-10-26T00:00:00.000Z'

type Row = { sync_id: string; updated_at?: string }

// Marks rows changed on or after `since`, untouched seed excepted; resolves with how many.
export function markChangedSince(engine: Pick<DbSyncEngine, 'markDirty'>, rows: Row[], since: string = LAUNCHER_REPAIR_SINCE): number {
  const changed = rows.filter(row => !isPristineSeed(row) && (row.updated_at ?? '') >= since)
  for (const row of changed) engine.markDirty(row.sync_id)
  return changed.length
}

// One cycle, then, the first time a cycle succeeds, the marking and a second
// cycle to push what it marked. A marking failure leaves the flag unset, so the
// next successful cycle tries again.
export async function cycleWithLauncherRepair(
  engine: Pick<DbSyncEngine, 'getLastSynced'>,
  runCycle: () => Promise<DbSyncResult>,
  flag: string,
  mark: () => Promise<number>,
): Promise<DbSyncResult> {
  const before = engine.getLastSynced()
  const result = await runCycle()
  if (localStorage.getItem(flag) === '1') return result
  const after = engine.getLastSynced()
  if (!after || after === before) return result
  try {
    const marked = await mark()
    localStorage.setItem(flag, '1')
    if (marked > 0) await runCycle()
  } catch (err) {
    console.warn('[lastglance] launcher-writes vault repair failed:', err)
  }
  return result
}
