import { directAccessTransport, type DirectAccessTransport } from '@/sync/directAccess'
import { useSnapshotFileSync, type UseSnapshotFileSyncArgs, type UseSnapshotFileSyncResult } from './useSnapshotFileSync'

// Direct Access sync (docs/direct-access.md): the shared snapshot-file hook
// (useSnapshotFileSync.ts) over the folder transport. Picking the folder is
// the decision, so this transport never asks the first-run question.

export interface UseDirectAccessSyncArgs extends Omit<UseSnapshotFileSyncArgs, 'transport'> {
  transport?: DirectAccessTransport
}

export { SKIPPED_RETRY_MS } from './useSnapshotFileSync'

export function useDirectAccessSync({ transport = directAccessTransport, ...rest }: UseDirectAccessSyncArgs = {}): Pick<UseSnapshotFileSyncResult, 'runSync' | 'lastError'> {
  const { runSync, lastError } = useSnapshotFileSync({ transport, ...rest })
  return { runSync, lastError }
}
