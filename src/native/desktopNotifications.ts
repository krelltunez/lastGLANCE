import type { ActionType, LocalNotificationSchema, PendingLocalNotificationSchema } from '@capacitor/local-notifications'
import type { DesktopNotifications, DesktopReminder } from './desktop'

// The LocalNotifications contract reminders.ts schedules through, over the
// desktop app's scheduler in main (docs/desktop-app.md, section 7;
// electron/reminderScheduler.ts). The reminder logic is unchanged; what the
// phones route in the page when a notification is answered
// (handleNotificationAction) is decided here, at schedule time, and carried to
// main as data: a click opens the deep-link token the phones' taps reach, and
// "Mark done" queues a completion through the command queue. The phones'
// "Send to dayGLANCE" button has no desktop equivalent yet and is left out.

type Extra = { choreSyncId?: string; kind?: string; personSyncId?: string }

/** The token a click on this reminder opens, as handleNotificationAction routes a tap. */
export function openTokenFor(extra: unknown): string | null {
  const e = (extra ?? {}) as Extra
  if (e.kind === 'person-date') return e.personSyncId ? `person:${e.personSyncId}` : 'people'
  if (e.kind === 'people-digest') return 'people'
  return e.choreSyncId ? `chore:${e.choreSyncId}` : null
}

function actionFor(id: string, title: string, extra: Extra): DesktopReminder['actions'][number] | null {
  if (id === 'mark_done' && extra.choreSyncId) return { id, title, command: { action: 'complete', payload: { chore_id: extra.choreSyncId } } }
  if (id === 'log' && extra.personSyncId) return { id, title, open: `log:${extra.personSyncId}` }
  if (id === 'open' && extra.personSyncId) return { id, title, open: `person:${extra.personSyncId}` }
  return null
}

/** One scheduled notification as main's reminder. */
export function desktopReminderFor(n: LocalNotificationSchema, types: ReadonlyMap<string, ActionType>): DesktopReminder {
  const extra = (n.extra ?? {}) as Extra & Record<string, unknown>
  const at = n.schedule?.at instanceof Date ? n.schedule.at.getTime() : Number((extra as { triggerAtMillis?: number }).triggerAtMillis ?? 0)
  const type = n.actionTypeId ? types.get(n.actionTypeId) : undefined
  const actions = (type?.actions ?? [])
    .map((a) => actionFor(a.id, a.title, extra))
    .filter((a): a is DesktopReminder['actions'][number] => a !== null)
  return { id: n.id, title: n.title ?? '', body: n.body ?? '', at, open: openTokenFor(extra), actions, extra }
}

/** The subset of LocalNotifications reminders.ts calls, over the desktop bridge. */
export function desktopNotificationsPlugin(bridge: DesktopNotifications) {
  const types = new Map<string, ActionType>()
  return {
    checkPermissions: () => bridge.checkPermissions(),
    // The OS asks on the first notification (macOS) or never asks (Windows, Linux).
    requestPermissions: () => bridge.checkPermissions(),
    registerActionTypes: async ({ types: list }: { types: ActionType[] }) => {
      for (const t of list) types.set(t.id, t)
    },
    schedule: async ({ notifications }: { notifications: LocalNotificationSchema[] }) => {
      await bridge.schedule(notifications.map((n) => desktopReminderFor(n, types)))
      return { notifications: notifications.map((n) => ({ id: n.id })) }
    },
    cancel: async ({ notifications }: { notifications: { id: number }[] }) => {
      await bridge.cancel(notifications.map((n) => n.id))
    },
    getPending: async (): Promise<{ notifications: PendingLocalNotificationSchema[] }> => {
      const list = await bridge.pending()
      return { notifications: list.map((r) => ({ id: r.id, title: r.title, body: r.body, extra: r.extra })) }
    },
  }
}
