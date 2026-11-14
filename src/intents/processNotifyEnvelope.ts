import { ACTIONS, EVENTS, SOURCE_APPS } from '@glance-apps/intents'
import type { Envelope, NotifyPayload } from '@glance-apps/intents'
import dayjs from 'dayjs'
import type { InteractionChannel } from '@/people/types'
import { clearSent } from './sentToDayglance'

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
  // People: a completed "Call Sam" task (its source_entity_id is the person)
  // logs a contact with them. Absent, such a notify is ignored as before.
  people?: PeopleNotifyDeps
}

export interface PeopleNotifyDeps {
  // The person and the channel to log on, or undefined when the id is not a
  // person this user sees.
  getPerson: (syncId: string) => Promise<{ name: string; channel: InteractionChannel } | undefined>
  interactionExists: (syncId: string) => Promise<boolean>
  logContact: (input: { personSyncId: string; channel: InteractionChannel; occurredAt?: string; syncId: string }) => Promise<void>
}

export async function processNotifyEnvelope(
  envelope: Envelope,
  deps: ProcessNotifyDeps,
): Promise<void> {
  if (envelope.action !== ACTIONS.NOTIFY) return

  const payload = envelope.payload
  if (payload.source_app !== SOURCE_APPS.LASTGLANCE) return
  // Word on a task this device sent: the duplicate-send warning stops
  // (sentToDayglance.ts), whatever else the notice does.
  if ((payload.event === EVENTS.COMPLETED || payload.event === EVENTS.DELETED) && payload.source_entity_id) {
    clearSent(payload.source_entity_id)
  }
  if (payload.event !== EVENTS.COMPLETED) return

  const choreSyncId = payload.source_entity_id
  if (!choreSyncId) return

  if (await deps.isAlreadyLogged?.(payload.event_id)) return

  const chore = await deps.getChore(choreSyncId)
  if (!chore) {
    await processPersonTask(payload, deps)
    return
  }

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

// The dayGLANCE task was "Call Sam": doing it means you reached out. The
// notify's event_id becomes the interaction's id, so a re-delivery logs once.
async function processPersonTask(
  payload: NotifyPayload,
  deps: ProcessNotifyDeps,
): Promise<void> {
  if (!deps.people) return
  const person = await deps.people.getPerson(payload.source_entity_id)
  if (!person) return
  if (await deps.people.interactionExists(payload.event_id)) return
  await deps.people.logContact({
    personSyncId: payload.source_entity_id,
    channel: person.channel,
    occurredAt: dayjs(payload.completed_at).isValid() ? payload.completed_at : undefined,
    syncId: payload.event_id,
  })
  deps.addActivityEntry({ type: 'received', message: `Contact with ${person.name} logged from dayGLANCE` })
}
