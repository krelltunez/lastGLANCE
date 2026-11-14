import { beforeEach, describe, expect, it } from 'vitest'
import { CreateSchema, SOURCE_APPS, taskIdFor } from '@glance-apps/intents'
import type { Chore } from '@/types'
import { choreCreateFields, type ChoreSend } from '@/intents/emitter'
import { clearSent, recordSent, unansweredSend } from '@/intents/sentToDayglance'
import { NOT_CONNECTED, sendChoreToDayglance, type SendDeps } from './sendToDayglance'
import { Refusal } from './writeShared'

function installLocalStorage(): void {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  } as Storage
}
installLocalStorage()
beforeEach(() => localStorage.clear())

const chore = {
  id: 1, sync_id: '33333333-3333-3333-3333-333333333333', name: 'Mop kitchen', category_id: 1, category_sync_id: null,
  target_cadence_days: 14, duration_minutes: 25, notify_when_overdue: false, auto_schedule_to_dayglance: false,
  preferred_schedule_behavior: null, seasonal_start: null, seasonal_end: null, details: null, pinned: false,
  assigned_user_sync_ids: [], created_at: '', updated_at: '', sort_order: 0,
} as unknown as Chore

/** Deps that record the send and answer with the id dayGLANCE would give, as emitChoreSend does. */
function deps(over: Partial<SendDeps> = {}) {
  const sends: ChoreSend[] = []
  const d: SendDeps = {
    targets: () => ['vault'],
    send: async (c, send) => {
      sends.push(send)
      const id = await taskIdFor(SOURCE_APPS.LASTGLANCE, c.sync_id, send.due)
      recordSent(c.sync_id, { taskId: id, due: send.due ?? null, sentAt: new Date().toISOString() })
      return id
    },
    unanswered: unansweredSend,
    ...over,
  }
  return { d, sends }
}

describe('what a send asks dayGLANCE for', () => {
  // Every released dayGLANCE validates a create against this strict schema: a
  // payload it refuses is a chore that never arrives.
  const valid = (send: ChoreSend) => CreateSchema.safeParse({ ...choreCreateFields(chore, send), source_app: SOURCE_APPS.LASTGLANCE }).success

  it('a timed send carries the duration; a date or the inbox carries none, which the schema would refuse', () => {
    const timed = choreCreateFields(chore, { due: '2026-11-15T09:00:00-07:00', allDay: false, duration: 25 })
    expect(timed).toMatchObject({ due: '2026-11-15T09:00:00-07:00', all_day: false, duration: 25 })
    expect(choreCreateFields(chore, { due: '2026-11-15', allDay: true, duration: 25 })).not.toHaveProperty('duration')
    const inbox = choreCreateFields(chore, { duration: 25 })
    expect(inbox).not.toHaveProperty('due')
    expect(inbox).not.toHaveProperty('duration')
    for (const send of [{ due: '2026-11-15T09:00:00-07:00', allDay: false, duration: 25 }, { due: '2026-11-15', allDay: true }, {}]) {
      expect(valid(send), JSON.stringify(send)).toBe(true)
    }
  })
})

describe('sendChoreToDayglance', () => {
  it('sends a timed block with the chore\'s own duration, and answers the task id dayGLANCE will give it', async () => {
    const { d, sends } = deps()
    const r = await sendChoreToDayglance(chore, { due: '2026-11-15T09:00:00-07:00', all_day: false }, d)
    expect(sends).toEqual([{ due: '2026-11-15T09:00:00-07:00', allDay: false, duration: 25 }])
    expect(r).toMatchObject({ placed: 'timed', pending: true, duration_minutes: 25, dayglance_task_id: 'fd071633-95dc-4088-a29f-6ccd56ea72e1' })
    expect(r).not.toHaveProperty('warning')
  })

  it('a duration asked for wins over the chore\'s; a date or the inbox has none', async () => {
    const { d, sends } = deps()
    await sendChoreToDayglance(chore, { due: '2026-11-15T09:00:00-07:00', all_day: false, duration_minutes: 45 }, d)
    expect(sends[0].duration).toBe(45)
    expect(await sendChoreToDayglance(chore, { due: '2026-11-16', all_day: true }, d)).toMatchObject({ placed: 'all_day', duration_minutes: null })
    expect(await sendChoreToDayglance(chore, {}, d)).toMatchObject({ placed: 'inbox', due: null, duration_minutes: null })
  })

  it('refuses, naming the setting, when the dayGLANCE integration is off', async () => {
    const { d, sends } = deps({ targets: () => [] })
    await expect(sendChoreToDayglance(chore, {}, d)).rejects.toMatchObject({ code: 'not_connected', message: NOT_CONNECTED })
    expect(NOT_CONNECTED).toContain('Settings, then Integrations, then dayGLANCE Integration')
    expect(sends).toEqual([])
  })

  it('warns, without refusing, when this device sent the chore for another time and has had no word since', async () => {
    const { d, sends } = deps()
    await sendChoreToDayglance(chore, { due: '2026-11-15', all_day: true }, d)
    // The same start again is the same task in dayGLANCE: nothing to warn about.
    expect(await sendChoreToDayglance(chore, { due: '2026-11-15', all_day: true }, d)).not.toHaveProperty('warning')
    const again = await sendChoreToDayglance(chore, { due: '2026-11-16T09:00:00-07:00', all_day: false }, d)
    expect(sends).toHaveLength(3)
    expect(again.warning).toMatch(/no word since/)
    expect(again.warning).toMatch(/dayglance_move_block/)
    expect(again.previous_send).toMatchObject({ dayglance_task_id: 'ad49bb95-aaa1-4dd1-9fa5-14d82a98362f', due: '2026-11-15' })
  })

  it('stops warning once dayGLANCE reports the task completed or deleted', async () => {
    const { d } = deps()
    await sendChoreToDayglance(chore, { due: '2026-11-15', all_day: true }, d)
    clearSent(chore.sync_id)
    expect(await sendChoreToDayglance(chore, { due: '2026-11-16', all_day: true }, d)).not.toHaveProperty('warning')
  })

  it('a bad duration is a validation error before anything is sent', async () => {
    const { d, sends } = deps()
    await expect(sendChoreToDayglance(chore, { due: '2026-11-15T09:00:00-07:00', all_day: false, duration_minutes: 0 }, d)).rejects.toBeInstanceOf(Refusal)
    expect(sends).toEqual([])
  })
})

describe('the sent record', () => {
  it('forgets sends older than it keeps', () => {
    recordSent('c1', { taskId: 't', due: null, sentAt: '2026-08-01T00:00:00.000Z' })
    expect(unansweredSend('c1', new Date('2026-08-10T00:00:00Z'))).not.toBeNull()
    expect(unansweredSend('c1', new Date('2026-11-14T00:00:00Z'))).toBeNull()
  })
})
