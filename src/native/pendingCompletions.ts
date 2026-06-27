import { drainPendingCompletions } from './widgetBridge'
import { db } from '@/db/client'
import { logCompletion } from '@/db/queries'
import { getMeUserSyncId } from '@/multiuser/settings'

// Drain widget-originated completions into the DB. A widget tap can't write to
// IndexedDB (it runs in the native process), so the native side optimistically
// updates its snapshot and queues the completion; the web app replays the queue
// here on next foreground.
//
// Each entry carries the sync_id the native side minted at tap time, so
// replaying via logCompletion is idempotent — no double-count if the queue is
// drained twice, or if the event already arrived from another device via sync.
export async function drainWidgetCompletions(): Promise<void> {
  const pending = await drainPendingCompletions()
  if (pending.length === 0) return

  let logged = false
  for (const p of pending) {
    try {
      const already = await db.completionEvents.where('sync_id').equals(p.syncId).count()
      if (already > 0) continue
      const chore = await db.chores.where('sync_id').equals(p.choreSyncId).first()
      if (chore?.id == null) continue
      await logCompletion(chore.id, {
        completedAt: p.completedAt,
        syncId: p.syncId,
        completedByUserSyncId: getMeUserSyncId(),
      })
      logged = true
    } catch {
      // Skip a malformed/unresolvable entry rather than failing the whole drain.
    }
  }
  if (logged) window.dispatchEvent(new CustomEvent('lg:chore-logged'))
}
