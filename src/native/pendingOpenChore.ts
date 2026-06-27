// A notification tap can arrive before the chore list has loaded (cold start
// from a killed app), so a one-shot event would be lost. Instead we stash the
// requested chore's sync_id here and let the view consume it once its data is
// ready — surviving any ordering between the tap and the first data load.
let pendingSyncId: string | null = null

export function setPendingOpenChore(syncId: string): void {
  pendingSyncId = syncId
}

export function peekPendingOpenChore(): string | null {
  return pendingSyncId
}

export function clearPendingOpenChore(): void {
  pendingSyncId = null
}
