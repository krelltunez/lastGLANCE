import { LocalNotifications } from '@capacitor/local-notifications'
// The bare singleton, not '@/i18n': that module boots the detector and HTTP
// backend as an import side effect, which node-side tests must not inherit.
// main.tsx imports '@/i18n' before anything schedules, so by the time these
// t() calls run the instance is initialized.
import i18n from 'i18next'
import { hasNativeReminders, isAndroid } from './platform'
import { desktopBridge } from './desktop'
import { desktopNotificationsPlugin } from './desktopNotifications'
import type { PendingLocalNotificationSchema } from '@capacitor/local-notifications'
import { getCategories, getChoresForCategory, logCompletion } from '@/db/queries'
import { db } from '@/db/client'
import { setPendingOpenChore } from './pendingOpenChore'
import { emitCreateIntent } from '@/intents/emitter'
import { anyIntentsTransportOn, intentsTransportsOn } from '@/intents/intentsAvailable'
import { ownedByMe } from '@/utils/choreFilter'
import { isInSeasonalWindow } from '@/utils/seasonal'
import { getMeUserSyncId, getMultiUserEnabled } from '@/multiuser/settings'
import { getAllPersonDates, getPeople } from '@/people/queries'
import { visibleToMe } from '@/people/home'
import { buildPeopleReminders, NEAR_DATE_DAYS, type PeopleReminder } from '@/people/reminders'
import { getDateReminderMinutes, getDigestMinutes, isDateRemindersOn } from '@/people/settings'
import { getActiveLocale } from '@/utils/datetime'
import { OPEN_PERSON_PENDING_EVENT, setPendingOpenPerson } from './pendingOpenPerson'
import type { ChoreWithLastCompletion } from '@/types'
import dayjs from 'dayjs'

// Phase 1: closed-app overdue notifications. The web app pre-computes each
// chore's next-overdue instant (last completion + cadence) and registers it with
// @capacitor/local-notifications, so notifications fire when the app is closed —
// replacing the in-WebView timer that only ran while the app was alive. Native
// owns closed-app delivery; the in-app toast in useNotifications.ts still covers
// the foreground case.
//
// Runs in both native shells; no-op on web/PWA. The scheduling model is shared,
// with three Android-only pieces skipped on iOS (notification channels, the
// exact-alarm permission prompt, and the per-build force-reschedule) and one
// iOS-only piece added (the 64-notification cap). Each is marked below.
//
// Timing differs by platform and that is accepted: Android schedules an exact
// alarm, iOS has no equivalent and the system may batch delivery. Fine for a
// single-shot "it's been N days" nudge; do not build anything time-critical on
// top of it.

// The calls the reminder sync makes, beyond the Android-only channel and
// exact-alarm ones: the phones' plugin, or the desktop app's scheduler.
type ReminderNotifications = Pick<typeof LocalNotifications, 'checkPermissions' | 'requestPermissions' | 'getPending' | 'cancel'> & {
  registerActionTypes(o: { types: Parameters<typeof LocalNotifications.registerActionTypes>[0]['types'] }): Promise<void>
  schedule(o: Parameters<typeof LocalNotifications.schedule>[0]): Promise<unknown>
}
let desktopPlugin: ReminderNotifications | null = null
export function reminderNotifications(): ReminderNotifications {
  const desktop = desktopBridge()
  if (!desktop) return LocalNotifications
  desktopPlugin ??= desktopNotificationsPlugin(desktop.notifications) as unknown as ReminderNotifications
  return desktopPlugin
}

const CHANNEL_ID = 'overdue'
// People reminders (dates and the daily digest) get their own channel, so
// either kind can be silenced in system settings without the other.
const PEOPLE_CHANNEL_ID = 'people'
const EXACT_PROMPTED_KEY = 'lg_exact_alarm_prompted'
// Per-build token reminders were last scheduled under. See the force-reschedule
// note in syncReminders for why every new build must re-bake each pending alarm.
// Keyed on the build timestamp, NOT the version name: resource IDs are reassigned
// on every aapt2 run, and we ship multiple builds per version (internal-test
// builds bump only versionCode), so a versionName check misses those rebuilds.
const BUILD_TOKEN_KEY = 'lg_reminders_build_token'

// Two action sets: "Mark done" alone, or with "Send to dayGLANCE" when cross-app
// intents are configured. The choice is baked into each notification at schedule
// time via actionTypeId, and refreshes whenever syncReminders re-runs.
const ACTION_TYPE = 'OVERDUE'
const ACTION_TYPE_DG = 'OVERDUE_DG'
// A date notification offers Log and Open. The digest has no buttons; its tap
// opens People.
const ACTION_TYPE_PERSON_DATE = 'PERSON_DATE'

// iOS keeps at most 64 pending local notifications per app and silently discards
// the rest — no error, the reminder simply never arrives. Our model is one
// single-shot notification per eligible chore, plus People dates and digests,
// so a heavy user can plausibly reach that, unlike on Android where there is no
// such limit. Cap below 64 rather than at it: the ceiling is per-app, not
// per-feature, so leaving headroom keeps a future notification of any other kind
// from being the one that gets dropped.
const IOS_PENDING_LIMIT = 56

// The soonest `n` by trigger time. When the cap bites, the reminders worth
// keeping are the ones about to fire: everything dropped here is further out
// than everything kept, and each later sync (foreground, completion, sync-apply)
// re-runs this and pulls the next tranche in as the near ones fire.
export function soonest<T extends { triggerAtMillis: number }>(items: T[], n: number): T[] {
  if (items.length <= n) return items
  return [...items].sort((a, b) => a.triggerAtMillis - b.triggerAtMillis).slice(0, n)
}

// How chores and People share the iOS cap (docs: the People spec): dates in
// the next two weeks first, then chores, then the digest, then dates further
// out. Each tier keeps its soonest, and each later sync pulls the next ones in
// as the near ones fire.
export type ReminderTier = 'near-date' | 'chore' | 'digest' | 'far-date'
const TIER_ORDER: ReminderTier[] = ['near-date', 'chore', 'digest', 'far-date']

export function withinCap<T extends { triggerAtMillis: number; tier: ReminderTier }>(items: T[], n: number): T[] {
  if (items.length <= n) return items
  const out: T[] = []
  for (const tier of TIER_ORDER) {
    const room = n - out.length
    if (room <= 0) break
    out.push(...soonest(items.filter(i => i.tier === tier), room))
  }
  return out
}

interface ReminderDescriptor {
  id: number // stable numeric id derived from the chore's or date's sync_id
  title: string
  body: string
  triggerAtMillis: number
  tier: ReminderTier
  channelId: string
  actionTypeId?: string
  // Routing for handleNotificationAction. Chore reminders carry choreSyncId
  // and no kind, as they always have, so ones scheduled by older builds
  // still route.
  extra: Record<string, unknown>
  dgEnabled: boolean // include the "Send to dayGLANCE" action button
}

// Deterministic positive 31-bit id from a chore's sync_id (UUID). Notification
// ids must be Java ints; mapping a chore to a stable id means re-scheduling
// replaces its alarm in place rather than stacking a duplicate.
export function reminderIdFor(syncId: string): number {
  let h = 0
  for (let i = 0; i < syncId.length; i++) {
    h = (Math.imul(31, h) + syncId.charCodeAt(i)) | 0
  }
  return (h & 0x7fffffff) || 1
}

// Action-button titles and the Android channel are registered once per app run
// — but they carry localized text, so a language switch invalidates them. The
// memo flags reset on languageChanged and the next syncReminders re-registers
// both (createChannel with an existing id updates its name in place). Pending
// notification BODIES re-bake through the body diff in syncReminders, which
// useReminders triggers on the same event.
let actionTypesReady = false
let channelsReady = false
i18n.on('languageChanged', () => {
  actionTypesReady = false
  channelsReady = false
})

async function ensureActionTypes(): Promise<void> {
  if (actionTypesReady) return
  try {
    await reminderNotifications().registerActionTypes({
      types: [
        { id: ACTION_TYPE, actions: [{ id: 'mark_done', title: i18n.t('notifications.markDone') }] },
        {
          id: ACTION_TYPE_DG,
          actions: [
            { id: 'mark_done', title: i18n.t('notifications.markDone') },
            { id: 'send_dg', title: i18n.t('notifications.sendToDayglance') },
          ],
        },
        {
          id: ACTION_TYPE_PERSON_DATE,
          // Both open the app (iOS would otherwise run them in the
          // background): logging needs the sheet, and Open shows the person.
          actions: [
            { id: 'log', title: i18n.t('people.row.log'), foreground: true },
            { id: 'open', title: i18n.t('people.reminders.open'), foreground: true },
          ],
        },
      ],
    })
    actionTypesReady = true
  } catch {
    // Best-effort; notifications still fire without action buttons.
  }
}

// Android-only: notification channels have no iOS equivalent, and the plugin's
// createChannel is a no-op there. Guarded explicitly rather than left to fail
// quietly, so the Android-only-ness is visible at the call site.
async function ensureChannels(): Promise<void> {
  if (channelsReady || !isAndroid()) return
  try {
    await LocalNotifications.createChannel({
      id: CHANNEL_ID,
      name: i18n.t('notifications.channelName'),
      description: i18n.t('notifications.channelDescription'),
      importance: 4, // HIGH — heads-up
      visibility: 1, // public
    })
    await LocalNotifications.createChannel({
      id: PEOPLE_CHANNEL_ID,
      name: i18n.t('people.reminders.channelName'),
      description: i18n.t('people.reminders.channelDescription'),
      importance: 4,
      // Private: names show on the lock screen only once unlocked.
      visibility: 0,
    })
    channelsReady = true
  } catch {
    // Channel creation is best-effort; scheduling still works on the default.
  }
}

// On Android 12+ exact alarms require the user to grant "Alarms & reminders".
// Without it the plugin silently falls back to inexact (Doze-batched) delivery —
// the classic "late when closed" failure. Prompt once, lazily, and only when we
// actually have something to schedule, so users who never opt a chore into
// reminders are never sent to Settings.
//
// Android-only: iOS has no exact-alarm concept and no such permission, so there
// is nothing to ask for and no Settings screen to send anyone to.
async function maybePromptExactAlarm(): Promise<void> {
  if (!isAndroid()) return
  if (localStorage.getItem(EXACT_PROMPTED_KEY)) return
  try {
    const status = await LocalNotifications.checkExactNotificationSetting()
    // Mark prompted up front so we never re-open Settings on subsequent syncs.
    localStorage.setItem(EXACT_PROMPTED_KEY, '1')
    if (status.exact_alarm !== 'granted') {
      await LocalNotifications.changeExactNotificationSetting()
    }
  } catch {
    // Method unavailable (older plugin/OS) — allowWhileIdle still gives
    // best-effort delivery.
  }
}

async function buildReminders(dgEnabled: boolean): Promise<ReminderDescriptor[]> {
  const meId = getMeUserSyncId()
  const categories = await getCategories()
  const lists = await Promise.all(categories.map(c => getChoresForCategory(c.id)))
  const now = Date.now()
  const out: ReminderDescriptor[] = []

  for (const list of lists) {
    for (const ch of list) {
      // Eligibility — mirrors the in-app overdue check (see plan §2).
      if (!ch.notify_when_overdue) continue
      if (ch.target_cadence_days == null) continue
      if (ch.last_completed_at == null) continue
      if (!isInSeasonalWindow(ch)) continue
      if (meId && !ownedByMe(ch.assigned_user_sync_ids ?? [], meId)) continue

      const triggerAtMillis = dayjs(ch.last_completed_at)
        .add(ch.target_cadence_days, 'day')
        .valueOf()
      // Already overdue → the in-app toast surfaces it; we only pre-schedule
      // future crossings (a past `at` would fire immediately on every sync).
      if (triggerAtMillis <= now) continue

      out.push({
        id: reminderIdFor(ch.sync_id),
        title: ch.name,
        // Baked in the language active at schedule time; a language switch
        // re-bakes it via the body diff in syncReminders (see useReminders).
        body: i18n.t('notifications.itsBeenDays', { count: ch.target_cadence_days }),
        triggerAtMillis,
        tier: 'chore',
        channelId: CHANNEL_ID,
        actionTypeId: dgEnabled ? ACTION_TYPE_DG : ACTION_TYPE,
        extra: { choreSyncId: ch.sync_id, deepLink: `lastglance://chore/${ch.sync_id}` },
        dgEnabled,
      })
    }
  }
  return out
}

export function peopleDescriptor(r: PeopleReminder, now: number = Date.now()): ReminderDescriptor {
  const triggerAtMillis = r.at.valueOf()
  const base = {
    id: reminderIdFor(r.key),
    title: r.title,
    body: r.body,
    triggerAtMillis,
    channelId: PEOPLE_CHANNEL_ID,
    dgEnabled: false,
  }
  if (r.kind === 'people-digest') {
    return { ...base, tier: 'digest', extra: { kind: r.kind } }
  }
  const near = triggerAtMillis - now <= NEAR_DATE_DAYS * 24 * 60 * 60 * 1000
  return {
    ...base,
    tier: near ? 'near-date' : 'far-date',
    actionTypeId: ACTION_TYPE_PERSON_DATE,
    extra: { kind: r.kind, personSyncId: r.personSyncId },
  }
}

async function buildPeopleDescriptors(): Promise<ReminderDescriptor[]> {
  const [people, dates] = await Promise.all([getPeople(), getAllPersonDates()])
  const mine = visibleToMe(people, getMultiUserEnabled(), getMeUserSyncId())
  const now = dayjs()
  return buildPeopleReminders(i18n.t.bind(i18n), mine, dates, {
    now,
    datesOn: isDateRemindersOn(),
    locale: getActiveLocale(),
    dateMinutes: getDateReminderMinutes(),
    digestMinutes: getDigestMinutes(),
  }).map(r => peopleDescriptor(r, now.valueOf()))
}

// Diff-replace the scheduled alarm set: cancel only what's removed or changed,
// schedule only what's new or changed. Avoids a blanket cancel-all that could
// drop an alarm in the window before it's re-registered.
export async function syncReminders(): Promise<void> {
  if (!hasNativeReminders()) return
  const notifications = reminderNotifications()
  try {
    let perm = await notifications.checkPermissions()
    if (perm.display !== 'granted') {
      perm = await notifications.requestPermissions()
      if (perm.display !== 'granted') return
    }
    await ensureChannels()
    await ensureActionTypes()

    // "Configured" means ANY transport is enabled (WebDAV intents, the
    // GLANCEvault DB transport, the Direct Access event set), the same question
    // IntentsContext.isConfigured answers. Checking fewer hid the action.
    const dgEnabled = anyIntentsTransportOn(intentsTransportsOn())
    const [chores, people] = await Promise.all([buildReminders(dgEnabled), buildPeopleDescriptors()])
    const all = [...chores, ...people]
    // iOS-only cap. On Android and the desktop the full set is scheduled; there is no limit.
    const desired = isAndroid() || desktopBridge() ? all : withinCap(all, IOS_PENDING_LIMIT)
    if (desired.length > 0) await maybePromptExactAlarm()

    // Android bakes each scheduled notification — including its small-icon
    // resource ID — at schedule time and re-posts that exact object when the
    // alarm later fires. Resource IDs are reassigned on every aapt2 run, so an
    // alarm scheduled by a previous build can fire under a new build with a stale
    // icon ID that now resolves to a different drawable (the ~1.7k-icon Lucide
    // set bundled for the widgets makes such a collision likely). On the first
    // sync under a new build, force-reschedule every reminder so its notification
    // is re-baked against the current resource IDs. Scheduling with an existing id
    // replaces the alarm in place, so no cancel gap is introduced.
    //
    // The token is the build timestamp, not the version name: IDs churn per build,
    // and same-version rebuilds (internal-test builds that bump only versionCode)
    // would slip past a versionName check and keep firing the stale icon.
    //
    // Android-only. The whole hazard is aapt2 reassigning drawable resource IDs
    // between builds; iOS notifications carry no resource ID, so forcing a full
    // reschedule there would churn every pending notification on each new build
    // to fix a problem it cannot have.
    const buildToken = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'dev'
    const force = isAndroid() && localStorage.getItem(BUILD_TOKEN_KEY) !== buildToken

    const desiredById = new Map(desired.map(r => [r.id, r]))
    const pending: PendingLocalNotificationSchema[] =
      (await notifications.getPending()).notifications
    const pendingById = new Map(pending.map(p => [p.id, p]))

    const changed = (p: PendingLocalNotificationSchema, d: ReminderDescriptor) => {
      const extra = (p.extra ?? {}) as { triggerAtMillis?: number; dg?: boolean }
      return (
        extra.triggerAtMillis !== d.triggerAtMillis ||
        p.title !== d.title ||
        p.body !== d.body ||
        (extra.dg ?? false) !== d.dgEnabled
      )
    }

    // In force mode keep pending reminders that are still desired — rescheduling
    // replaces them by id — and cancel only orphans; otherwise cancel what's
    // removed or changed.
    const toCancel = pending.filter(p => {
      const d = desiredById.get(p.id)
      return !d || (!force && changed(p, d))
    })
    if (toCancel.length > 0) {
      await notifications.cancel({ notifications: toCancel.map(p => ({ id: p.id })) })
    }

    const cancelledIds = new Set(toCancel.map(p => p.id))
    const toSchedule = force
      ? desired
      : desired.filter(d => !pendingById.has(d.id) || cancelledIds.has(d.id))
    if (toSchedule.length > 0) {
      await notifications.schedule({
        notifications: toSchedule.map(d => ({
          id: d.id,
          title: d.title,
          body: d.body,
          channelId: d.channelId,
          actionTypeId: d.actionTypeId,
          schedule: { at: new Date(d.triggerAtMillis), allowWhileIdle: true },
          extra: {
            ...d.extra,
            triggerAtMillis: d.triggerAtMillis,
            dg: d.dgEnabled,
          },
        })),
      })
    }

    // Only after a clean pass — a mid-sync failure leaves the marker stale so the
    // next sync retries the force-reschedule rather than skipping it.
    localStorage.setItem(BUILD_TOKEN_KEY, buildToken)
  } catch {
    // Best-effort: reminders must never disrupt the app.
  }
}

async function markChoreDone(choreSyncId: string): Promise<void> {
  const chore = await db.chores.where('sync_id').equals(choreSyncId).first()
  if (chore?.id == null) return
  // Attribute to the current "Me" user, matching in-app completion (ChoreRow).
  await logCompletion(chore.id, { completedByUserSyncId: getMeUserSyncId() })
  // Refreshes the list/heatmap, repushes the widget snapshot, and re-runs
  // syncReminders — which reschedules this chore's next overdue alarm.
  window.dispatchEvent(new CustomEvent('lg:chore-logged'))
}

async function sendChoreToDayGlance(choreSyncId: string): Promise<void> {
  const chore = await db.chores.where('sync_id').equals(choreSyncId).first()
  if (!chore) return
  // emitCreateIntent re-checks configuration internally and no-ops if intents
  // aren't set up. It only reads name/sync_id/assignees, so the missing
  // last/elapsed fields are irrelevant here.
  await emitCreateIntent({ ...chore, last_completed_at: null, elapsed_days: null } as ChoreWithLastCompletion)
}

// Routes a notification interaction. Platform behavior differs, observed on
// device (2026-08): on Android every action opens the app, then the plugin
// replays this. On iOS an action button does NOT foreground the app — the
// system runs the extension-less action in the background, the plugin retains
// it, and it replays here on the next launch, so a "Mark done" tapped at night
// is logged the next time the app opens. Retained across a cold start on both
// platforms. 'tap' is the body press; 'mark_done' / 'send_dg' are the action
// buttons.
export function handleNotificationAction(actionId: string, extra: unknown): void {
  const kind = (extra as { kind?: string } | null)?.kind
  if (kind === 'person-date' || kind === 'people-digest') {
    handlePeopleAction(actionId, extra as { kind: string; personSyncId?: string })
    return
  }
  const choreSyncId = (extra as { choreSyncId?: string } | null)?.choreSyncId
  if (!choreSyncId) return
  if (actionId === 'mark_done') {
    void markChoreDone(choreSyncId)
    return
  }
  if (actionId === 'send_dg') {
    void sendChoreToDayGlance(choreSyncId)
    return
  }
  // Body tap (actionId 'tap') or anything else → focus the chore. Recorded as a
  // durable pending request the Ribbon consumes once its data has loaded, so the
  // cold-start ordering between the tap and the first data load doesn't matter.
  setPendingOpenChore(choreSyncId)
  window.dispatchEvent(new Event('lg:open-chore-pending'))
}

// People notifications: Log opens the quick-log sheet for the person, a date's
// body tap or Open shows the person, and the digest opens People. Recorded as
// a pending request for PeopleHome, which switches mode first (App) and takes
// it once People has loaded.
function handlePeopleAction(actionId: string, extra: { kind: string; personSyncId?: string }): void {
  const personSyncId = extra.personSyncId
  if (extra.kind === 'person-date' && personSyncId) {
    setPendingOpenPerson({ action: actionId === 'log' ? 'log' : 'open', personSyncId })
  } else {
    setPendingOpenPerson({ action: 'home' })
  }
  window.dispatchEvent(new Event(OPEN_PERSON_PENDING_EVENT))
}
