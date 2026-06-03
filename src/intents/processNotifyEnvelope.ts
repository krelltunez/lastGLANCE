import { ACTIONS, EVENTS, SOURCE_APPS } from '@glance-apps/intents'
import type { Envelope } from '@glance-apps/intents'
import dayjs from 'dayjs'

export interface ProcessNotifyDeps {
  getChore: (id: number) => Promise<{ name: string } | undefined>
  logCompletion: (
    choreId: number,
    opts: { completedAt?: string; source?: 'manual' | 'dayglance'; completedByUserSyncId?: string | null; syncId?: string }
  ) => Promise<number>
  addActivityEntry: (entry: { type: 'received' | 'error' | 'warning' | 'sent'; message: string }) => void
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

  const choreId = parseInt(payload.source_entity_id, 10)
  if (isNaN(choreId)) return

  const chore = await deps.getChore(choreId)
  if (!chore) return

  await deps.logCompletion(choreId, {
    completedAt: dayjs(payload.completed_at).isValid() ? payload.completed_at : undefined,
    source: 'dayglance',
    completedByUserSyncId: payload.completed_by_user_id ?? null,
    syncId: payload.event_id,
  })

  deps.addActivityEntry({ type: 'received', message: `"${chore.name}" completed in dayGLANCE` })
  deps.dispatchChoreLogged?.()
  deps.onNewCompletion?.()
}
