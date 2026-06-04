import { ACTIONS, EVENTS, SOURCE_APPS } from '@glance-apps/intents'
import type { Envelope } from '@glance-apps/intents'
import dayjs from 'dayjs'

export interface ProcessNotifyDeps {
  getChore: (syncId: string) => Promise<{ id: number; name: string } | undefined>
  logCompletion: (
    choreId: number,
    opts: { completedAt?: string; source?: 'manual' | 'dayglance'; completedByUserSyncId?: string | null; syncId?: string }
  ) => Promise<number>
  addActivityEntry: (entry: { type: 'received' | 'error' | 'warning' | 'sent'; message: string }) => void
  isAlreadyLogged?: (syncId: string) => Promise<boolean>
  onNewCompletion?: () => void
  dispatchChoreLogged?: () => void
}

export async function processNotifyEnvelope(
  envelope: Envelope,
  deps: ProcessNotifyDeps,
): Promise<void> {
  if (envelope.action !== ACTIONS.NOTIFY) return

  const payload = envelope.payload
  if (payload.source_app !== SOURCE_APPS.LASTGLANCE) return
  if (payload.event !== EVENTS.COMPLETED) return

  const choreSyncId = payload.source_entity_id
  if (!choreSyncId) return

  if (await deps.isAlreadyLogged?.(payload.event_id)) return

  const chore = await deps.getChore(choreSyncId)
  if (!chore) return

  await deps.logCompletion(chore.id, {
    completedAt: dayjs(payload.completed_at).isValid() ? payload.completed_at : undefined,
    source: 'dayglance',
    completedByUserSyncId: payload.completed_by_user_id ?? null,
    syncId: payload.event_id,
  })

  deps.addActivityEntry({ type: 'received', message: `"${chore.name}" completed in dayGLANCE` })
  deps.dispatchChoreLogged?.()
  deps.onNewCompletion?.()
}
