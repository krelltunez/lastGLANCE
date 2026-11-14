import type { Chore } from '@/types'
import { emitChoreSend, enabledIntentTargets, type ChoreSend } from '@/intents/emitter'
import { unansweredSend } from '@/intents/sentToDayglance'
import { DURATION_MAX_MINUTES, isDurationMinutes } from '@/utils/choreDuration'
import { refuse } from './writeShared'

// lastglance_send_to_dayglance on the page side: a chore to dayGLANCE as a
// linked task, through the same GLANCE intents every other send uses, so a
// completion in dayGLANCE comes back as the chore done. Main has already read
// `start` into a due: a time (an ISO instant with its offset), a date, or none
// (the inbox).

export interface SendDeps {
  targets: () => unknown[]
  send: typeof emitChoreSend
  unanswered: typeof unansweredSend
}

const defaultDeps: SendDeps = { targets: enabledIntentTargets, send: emitChoreSend, unanswered: unansweredSend }

export const NOT_CONNECTED =
  'dayGLANCE is not connected: lastGLANCE sends chores to dayGLANCE through its dayGLANCE integration, which is off on ' +
  'this device. Ask the user to turn it on in lastGLANCE: Settings, then Integrations, then dayGLANCE Integration.'

export async function sendChoreToDayglance(
  chore: Chore,
  p: { due?: unknown; all_day?: unknown; duration_minutes?: unknown },
  deps: SendDeps = defaultDeps,
): Promise<Record<string, unknown>> {
  if (deps.targets().length === 0) refuse('not_connected', NOT_CONNECTED)
  const due = typeof p.due === 'string' ? p.due : undefined
  const timed = due !== undefined && p.all_day === false
  if (p.duration_minutes !== undefined && p.duration_minutes !== null && !isDurationMinutes(p.duration_minutes)) {
    refuse('validation', `duration_minutes must be a whole number of minutes, 1 to ${DURATION_MAX_MINUTES}.`)
  }
  // The duration asked for, else the chore's own; only a timed send carries one.
  const duration = timed ? (p.duration_minutes as number | undefined) ?? chore.duration_minutes ?? undefined : undefined
  const send: ChoreSend = { ...(due !== undefined && { due, allDay: !timed }), ...(duration !== undefined && { duration }) }

  const before = deps.unanswered(chore.sync_id)
  const taskId = await deps.send(chore, send)
  if (taskId === null) refuse('not_connected', NOT_CONNECTED)

  const result: Record<string, unknown> = {
    chore_id: chore.sync_id,
    dayglance_task_id: taskId,
    pending: true,
    placed: due === undefined ? 'inbox' : timed ? 'timed' : 'all_day',
    due: due ?? null,
    duration_minutes: duration ?? null,
  }
  // The same chore, sent before for another time, with no word since: maybe a second task (sentToDayglance.ts).
  if (before && before.taskId !== taskId) {
    result.warning = `This device sent this chore to dayGLANCE before, on ${before.sentAt.slice(0, 10)} ` +
      `(${before.due === null ? 'to the inbox' : `for ${before.due}`}, task ${before.taskId}), and has had no word since that it ` +
      'was completed or deleted. If that task is still open, this send made a second one: move or reschedule the first with ' +
      'dayGLANCE\'s tools (dayglance_move_block, dayglance_schedule_task) by its id rather than sending again, and remove ' +
      'the extra one in dayGLANCE.'
    result.previous_send = { dayglance_task_id: before.taskId, due: before.due, sent_at: before.sentAt }
  }
  return result
}
