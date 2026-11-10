import { describe, expect, it, vi } from 'vitest'
import { desktopNotificationsPlugin, desktopReminderFor, openTokenFor } from './desktopNotifications'
import type { DesktopReminder } from './desktop'

const types = new Map([
  ['OVERDUE_DG', { id: 'OVERDUE_DG', actions: [{ id: 'mark_done', title: 'Mark done' }, { id: 'send_dg', title: 'Send to dayGLANCE' }] }],
  ['PERSON_DATE', { id: 'PERSON_DATE', actions: [{ id: 'log', title: 'Log' }, { id: 'open', title: 'Open' }] }],
])
const at = new Date('2026-11-12T09:00:00Z')

describe('desktop reminders, page side', () => {
  it('a chore reminder opens the chore, and Mark done queues a completion', () => {
    const r = desktopReminderFor({ id: 7, title: 'Water plants', body: "It's been 7 days", actionTypeId: 'OVERDUE_DG', schedule: { at }, extra: { choreSyncId: 'c1', triggerAtMillis: at.getTime(), dg: true } }, types)
    expect(r).toEqual({
      id: 7, title: 'Water plants', body: "It's been 7 days", at: at.getTime(), open: 'chore:c1',
      actions: [{ id: 'mark_done', title: 'Mark done', command: { action: 'complete', payload: { chore_id: 'c1' } } }],
      extra: { choreSyncId: 'c1', triggerAtMillis: at.getTime(), dg: true },
    })
  })

  it('a People date opens the person, with Log and Open; the digest opens People', () => {
    const date = desktopReminderFor({ id: 8, title: 'Maya', body: 'Birthday', actionTypeId: 'PERSON_DATE', schedule: { at }, extra: { kind: 'person-date', personSyncId: 'p1' } }, types)
    expect(date.open).toBe('person:p1')
    expect(date.actions).toEqual([{ id: 'log', title: 'Log', open: 'log:p1' }, { id: 'open', title: 'Open', open: 'person:p1' }])
    expect(openTokenFor({ kind: 'people-digest' })).toBe('people')
    expect(openTokenFor({})).toBeNull()
  })

  it('schedules, cancels and reads back through main, as reminders.ts calls them', async () => {
    const scheduled: DesktopReminder[] = []
    const bridge = {
      checkPermissions: vi.fn(async () => ({ display: 'granted' })),
      schedule: vi.fn(async (list: DesktopReminder[]) => { scheduled.push(...list); return list.length }),
      cancel: vi.fn(async () => {}),
      pending: vi.fn(async () => scheduled),
    }
    const plugin = desktopNotificationsPlugin(bridge)
    await plugin.registerActionTypes({ types: [...types.values()] })
    await plugin.schedule({ notifications: [{ id: 7, title: 'Water plants', body: 'b', actionTypeId: 'OVERDUE_DG', schedule: { at }, extra: { choreSyncId: 'c1' } }] })
    expect(scheduled[0].actions.map((a) => a.id)).toEqual(['mark_done'])   // send_dg has no desktop equivalent
    expect((await plugin.getPending()).notifications).toEqual([{ id: 7, title: 'Water plants', body: 'b', extra: { choreSyncId: 'c1' } }])
    await plugin.cancel({ notifications: [{ id: 7 }] })
    expect(bridge.cancel).toHaveBeenCalledWith([7])
    expect(await plugin.requestPermissions()).toEqual({ display: 'granted' })
  })
})
