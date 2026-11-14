import { ACTIONS, SOURCE_APPS, eventId, type CreatePayload } from '@glance-apps/intents'
import dayjs from 'dayjs'
import type { ChoreWithLastCompletion } from '@/types'
import { getIntentsConfig, isIntentsConfigured, addActivityEntry } from './config'
import { isDbIntentsEnabled } from './dbConfig'
import { isDirectAccessIntentsEnabled } from './directAccessIntentsConfig'
import { isICloudIntentsEnabled } from './icloudIntents'
import { outbox, type OutboxIntent, type TransportName } from './outbox'
import { flushIntents } from './flushIntents'
import { dayglanceTaskId } from './dayglanceTaskId'
import { recordSent } from './sentToDayglance'

// Builds the RAW intent (action + payload + emit metadata) for a chore and
// stamps a STABLE event_id NOW, at emit time. That id is both the outbox entry
// id and the server idempotency key: it flows unchanged through every retry and
// into the envelope the deliverer builds (the deliverer passes it to
// buildEnvelope/buildEncryptedEnvelope), so re-delivery is idempotent. The
// payload mirrors the former buildCreateEnvelope, but NO envelope is built here —
// encryption happens at flush in the deliverer.
export function buildCreateIntent(chore: ChoreWithLastCompletion): OutboxIntent {
  return buildCreateIntentFor(choreCreateFields(chore, { due: dayjs().format('YYYY-MM-DD'), allDay: true }))
}

/**
 * Where a chore goes in dayGLANCE: a time (an ISO instant with its offset,
 * with a duration in minutes), a date (all day), or neither (the inbox). The
 * intents schema takes a duration only with a time; on a date or the inbox,
 * dayGLANCE gives the task its default length.
 */
export interface ChoreSend {
  due?: string
  allDay?: boolean
  duration?: number
}

export function choreCreateFields(chore: Pick<ChoreWithLastCompletion, 'name' | 'sync_id' | 'assigned_user_sync_ids'>, send: ChoreSend): CreateFields {
  const assignedUserIds = chore.assigned_user_sync_ids ?? []
  const timed = send.due !== undefined && send.allDay === false
  return {
    title: chore.name,
    ...(send.due !== undefined && { due: send.due, all_day: !timed }),
    ...(timed && send.duration !== undefined && { duration: send.duration }),
    source_entity_id: chore.sync_id,
    ...(assignedUserIds.length > 0 && { assigned_user_ids: assignedUserIds }),
  }
}

// The fields of a CREATE payload a caller chooses; source_app is always
// lastGLANCE. People sends its tasks, dates and timeline entries through this.
export type CreateFields = Omit<CreatePayload, 'source_app'>

export function buildCreateIntentFor(fields: CreateFields): OutboxIntent {
  const emittedAt = new Date()
  return {
    event_id: eventId(emittedAt),
    action: ACTIONS.CREATE,
    emitted_by: SOURCE_APPS.LASTGLANCE,
    emitted_at: emittedAt.toISOString(),
    payload: { ...fields, source_app: SOURCE_APPS.LASTGLANCE },
  }
}

// The transports that should receive an intent right now: only the enabled ones.
// 'webdav' when the WebDAV intents config is enabled+complete; 'vault' when the
// GLANCEvault DB intents transport is enabled; 'directAccess' when its opt-in
// is on and a folder is connected; 'icloud' when its opt-in is on (iOS).
export function enabledIntentTargets(): TransportName[] {
  const targets: TransportName[] = []
  if (isIntentsConfigured(getIntentsConfig())) targets.push('webdav')
  if (isDbIntentsEnabled()) targets.push('vault')
  if (isDirectAccessIntentsEnabled()) targets.push('directAccess')
  if (isICloudIntentsEnabled()) targets.push('icloud')
  return targets
}

// Collaborators, injectable for tests. Production uses the real singleton outbox,
// the enabled-targets resolver, and the deliverer-wired flush.
export interface EmitDeps {
  targets: () => TransportName[]
  enqueue: (intent: OutboxIntent, targets: TransportName[]) => Promise<void>
  // The emit path fires-and-forgets the flush and ignores its outcome (the
  // Activity-Log reconcile happens inside flushIntents), so the result type is
  // intentionally unconstrained here.
  flush: () => Promise<unknown>
}

const defaultEmitDeps: EmitDeps = {
  targets: enabledIntentTargets,
  enqueue: (intent, targets) => outbox.enqueue(intent, targets),
  flush: flushIntents,
}

// Emits a CREATE intent by ENQUEUEing it durably to every enabled transport and
// triggering a flush. Returns true once the intent is queued (durable; it will
// not be lost), false only when no transport is enabled (nothing to do). A
// failed ENQUEUE rejects (it is NOT swallowed), so a caller gating side effects
// on success — e.g. the auto-schedule "sent today" marker — does not record
// progress for an intent that was never persisted.
//
// Delivery is asynchronous via the outbox + deliverers: a transient failure
// (e.g. the vault key not ready yet) keeps that target pending and is retried;
// it is never dropped, and the vault is never sent plaintext. This function no
// longer builds envelopes or sends over any transport directly — every send now
// goes through the outbox.
export async function emitCreateIntent(
  chore: ChoreWithLastCompletion,
  deps: EmitDeps = defaultEmitDeps,
): Promise<boolean> {
  const intent = buildCreateIntent(chore)
  const queued = await emitIntent(intent, `Queued "${chore.name}" for dayGLANCE`, deps)
  if (queued) await rememberSend(chore.sync_id, (intent.payload as CreatePayload).due)
  return queued
}

/**
 * Send a chore where the assistant chose (lastglance_send_to_dayglance).
 * Returns the id dayGLANCE will give the task, or null when no transport is
 * enabled (nothing was sent).
 */
export async function emitChoreSend(
  chore: Pick<ChoreWithLastCompletion, 'name' | 'sync_id' | 'assigned_user_sync_ids'>,
  send: ChoreSend,
  deps: EmitDeps = defaultEmitDeps,
): Promise<string | null> {
  const queued = await emitIntent(buildCreateIntentFor(choreCreateFields(chore, send)), `Queued "${chore.name}" for dayGLANCE`, deps)
  return queued ? rememberSend(chore.sync_id, send.due) : null
}

/** Note the send for the duplicate-send warning (sentToDayglance.ts), and return its task id. */
async function rememberSend(choreSyncId: string, due: string | undefined): Promise<string> {
  const taskId = await dayglanceTaskId(choreSyncId, due)
  recordSent(choreSyncId, { taskId, due: due ?? null, sentAt: new Date().toISOString() })
  return taskId
}

// The same for any CREATE payload (People). `activity` is the Activity-Log
// line, naming the app the item is for.
export async function emitCreate(
  fields: CreateFields,
  activity: string,
  deps: EmitDeps = defaultEmitDeps,
): Promise<boolean> {
  return emitIntent(buildCreateIntentFor(fields), activity, deps)
}

async function emitIntent(intent: OutboxIntent, activity: string, deps: EmitDeps): Promise<boolean> {
  const targets = deps.targets()
  if (targets.length === 0) return false

  // Durable before returning: a resolved enqueue means "queued, will be delivered".
  await deps.enqueue(intent, targets)
  // Carry the event_id + direction + delivery state so a later flush can match
  // this entry and advance its chip queued -> waiting for key -> delivered. The
  // type stays 'sent' (the existing blue badge); delivery is a separate axis.
  addActivityEntry({
    type: 'sent',
    direction: 'out',
    eventId: intent.event_id,
    delivery: 'queued',
    message: activity,
  })

  // Trigger delivery now; the outbox's in-flight lock guards overlapping flushes.
  deps.flush().catch(() => { /* failures surface via the deliverers/outbox */ })
  return true
}
