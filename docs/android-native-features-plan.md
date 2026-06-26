# Android Native Features — Implementation Plan

Widgets, actionable notifications, and shortcuts for the lastGLANCE Android
app, designed so all three share one data bridge and one action router.

This plan was informed by a teardown of how the sibling app **dayGLANCE**
solved timely closed-app notifications (its process is referenced throughout).
Where lastGLANCE differs from dayGLANCE, it is called out explicitly.

> **▶ RESUME HERE (last updated 2026-06-26)**
> - **Phase 0 + Phase 1 built** on branch `claude/wonderful-mccarthy-abm730`
>   (PR #126). Web build + 58 tests green; **Android not yet compiled/device-tested.**
> - **Phase 1** = exact-alarm overdue notifications via `@capacitor/local-notifications`
>   (Path A). Plugin handles reboot re-registration; we added `SCHEDULE_EXACT_ALARM`
>   + a lazy one-time exact-alarm prompt.
> - **Next action is yours:** on-device smoke test of both (widget refresh; kill the
>   app, advance a chore past cadence, confirm the notification fires — test Doze via
>   `adb shell dumpsys deviceidle force-idle`).
> - **Still open:** RemoteViews (as built) vs Glance for widgets (Phase 0). Next code
>   phase is **Phase 2** (action widgets + optimistic tap-to-complete).
> - **Settled:** Path A (B backup); "clearly same family"; no battery-opt prompt;
>   defer the WorkManager re-arm backstop until testing proves OEM killers clear alarms.

---

## 1. Context & the core constraint

lastGLANCE is a **Capacitor 8** app: the UI is a WebView, and all data lives in
**IndexedDB (Dexie)** *inside* the WebView (`src/db/client.ts`). Native
home-screen widgets and `AlarmManager`-driven notifications run in a **separate
process** and **cannot read IndexedDB**. So every native feature needs an
explicit bridge to the data.

Two bridges cover everything:

1. **Snapshot bridge** (read path): the WebView writes a denormalized JSON
   snapshot to native `SharedPreferences` whenever relevant state changes.
   Widgets and any native notification logic read *that*, never the DB.
2. **Pre-scheduled alarms** (notification path): the WebView computes each
   reminder's absolute trigger time and hands the full set to native, which
   registers exact alarms. Native never reads data to *decide* what to fire —
   the alarm's extras are the payload.

Both are validated patterns: dayGLANCE ships exactly this shape (SharedPreferences
snapshot + pre-scheduled `setExactAndAllowWhileIdle` alarms), with **no** native
SQLite mirror, **no** headless JS runtime, and **no** headless WebView.

### What this means: no background data runtime needed (for v1)

A scheduler (AlarmManager/WorkManager) only answers *"when do I wake up."* It does
**not** give native code a way to run Dexie. Because reminders are fully
pre-scheduled and widgets read a snapshot, **no v1 feature needs background access
to the DB.** The only feature that would is closed-app *remote* CRDT sync —
deliberately out of scope (dayGLANCE doesn't do it either; it reconciles on next
foreground, same as lastGLANCE today).

---

## 2. The data-model mapping (the one real divergence)

dayGLANCE tasks are **time-anchored** (a task has an absolute scheduled time), so
"pre-schedule today's triggers" is natural. lastGLANCE chores are
**cadence-anchored** (recency since last done). The resolution:

> A chore's overdue moment **is** an absolute time, knowable the instant it is
> completed: `last_completed_at + target_cadence_days`.

So every eligible chore contributes **0 or 1 future alarm** at its next-overdue
instant. The dayGLANCE model maps over cleanly — we just recompute a chore's
alarm on completion / cadence edit / app open rather than re-pushing a daily list.

**Eligibility** for an overdue alarm (mirrors `useNotifications.ts` today):
- `notify_when_overdue === true`
- `target_cadence_days != null`
- has at least one completion (`last_completed_at != null`)
- not currently out of its seasonal window (`seasonal_start`/`seasonal_end`)
- (multi-user) owned by me — unassigned or assigned to `meId`
  (`utils/choreFilter.ts: ownedByMe`)

**Brand fit — fire once, don't nag.** dayGLANCE re-nudges daily. lastGLANCE's
ethos is *"information, not guilt"* (README). Schedule a **single** alarm at the
overdue moment per chore. Simpler (no daily repeat) and on-brand. Re-arming only
happens when the chore is completed (next-overdue moves forward) or its
cadence/seasonal/notify settings change.

---

## 3. Shared infrastructure (build once, the spine)

### 3a. Capacitor plugin: `WidgetBridge` (custom, local)

Thin Kotlin plugin exposing JS-callable methods. dayGLANCE uses
`addJavascriptInterface`; on Capacitor we wrap the same logic as a plugin.

| Method | Purpose |
|---|---|
| `updateSnapshot({ json })` | Persist snapshot to `SharedPreferences("lastglance_shared")`, trigger widget update |
| `syncReminders({ reminders })` | Diff-replace the alarm set (see 3c) |
| `getPendingActions()` | Drain queued widget/notification actions into JS |
| `clearPendingActions({ ids })` | Ack drained actions |

JS wrappers live in `src/native/widgetBridge.ts`, null-safe / no-op on web+PWA
(guard with `Capacitor.isNativePlatform()`, like `src/native/statusBar.ts`).

### 3b. Snapshot schema (`SharedPreferences` key `snapshot`)

Written by the WebView; the single source of truth for native reads.

```jsonc
{
  "version": 1,
  "generatedAt": "2026-06-20T12:00:00Z",
  "counts": { "overdue": 3, "soon": 5 },
  "heatmap": { "2026-06-19": 2, "2026-06-20": 1 },   // last ~120 days
  "chores": [
    {
      "syncId": "uuid",
      "name": "Water plants",
      "icon": "droplet",                  // lucide name → mapped to a vector drawable
      "categoryName": "Home",
      "lastCompletedAt": "2026-06-15T09:00:00Z",
      "elapsedDays": 5.2,
      "targetCadenceDays": 7,
      "ratio": 0.74,                       // elapsed / target (getFillRatio)
      "color": "#f59e0b",                  // getCadenceColor(ratio)
      "state": "soon"                      // fresh | soon | overdue | none
    }
  ]
}
```

Generated by a new `src/native/snapshot.ts` from existing queries
(`getCategories` + `getChoresForCategory`, `getAllCompletionCounts`) and existing
helpers (`getFillRatio`, `getCadenceColor`, `needsAttention` in `utils/cadence.ts`).
Pushed:
- on app start
- on `lg:chore-logged`, `lg:sync-applied` events (already emitted; see
  `App.tsx:333`/`338`)
- on `visibilitychange` → hidden (app pausing), so the snapshot is fresh for the
  launcher

### 3c. Reminder payload (`syncReminders`)

```jsonc
{
  "id": "overdue:<choreSyncId>",        // stable → PendingIntent request code = id.hashCode()
  "choreSyncId": "uuid",
  "title": "Water plants",
  "body": "Overdue — last done 7 days ago",
  "triggerAtMillis": 1750000000000,     // last_completed_at + cadence
  "deepLink": "lastglance://chore/<choreSyncId>"
}
```

Native turns each into `setExactAndAllowWhileIdle(RTC_WAKEUP, …)` (the load-bearing
call — fires precisely and pierces Doze) to a `BroadcastReceiver` that renders the
notification from the alarm's own extras. **Diff-replace, not cancel-all**: compare
stored vs new set, only touch changed entries (dayGLANCE's race-avoidance lesson).

Notification id = `choreSyncId.hashCode()` so a re-fired reminder for the same
chore replaces rather than stacks.

### 3d. Action router (collapse to one path)

dayGLANCE's hindsight advice: route widgets + notification actions + shortcuts all
through the **shared `@glance-apps/intents` dispatcher** instead of a second
ad-hoc channel. lastGLANCE already depends on `@glance-apps/intents` (^1.3.3) and
already has the receive half in `processNotifyEnvelope.ts` /
`useIntentsPoller.ts`.

URI scheme, two verb classes:

| URI | Verb | Effect |
|---|---|---|
| `lastglance://chore/<syncId>` | navigate | open app, focus chore (reuse `lg:open-chore` event, `useNotifications.ts:72`) |
| `lastglance://filter/soon` | navigate | open app with attention filter on (`setAttentionOnly`, `App.tsx:124`) |
| `lastglance://complete/<syncId>` | act | log completion (idempotent, see Phase 2) |

Native components can't call JS directly, so "act" intents land in a **pending
queue** in `SharedPreferences`; JS drains via `getPendingActions()` on
`visibilitychange` (same shape as the existing intents poller).

---

## 4. Phases

### Phase 0 — Snapshot bridge + heatmap widget (read-only) — ✅ BUILT (PR #126)

**Goal:** prove the whole pipeline with zero write-back risk.

- `WidgetBridge` plugin with `updateSnapshot` only. ✅
- `src/native/snapshot.ts` + wire its triggers (start / `lg:chore-logged` /
  `lg:sync-applied` / pause). ✅ (via `src/hooks/useWidgetSnapshot.ts`)
- A widget rendering the activity heatmap from `snapshot.heatmap`, honoring
  light/dark. **Implemented as a classic `RemoteViews` AppWidget drawing a Canvas
  bitmap (Java), NOT Jetpack Glance** — deliberate deviation to avoid the
  Compose/Kotlin Gradle setup for a non-interactive widget and keep the change
  dependency-free. **OPEN DECISION:** keep RemoteViews here and adopt Glance only
  for the interactive Phase 2 widgets, or unify on Glance now. Awaiting an
  on-device look before deciding.
- Tap → `lastglance://filter/soon` (opens app only; router lands in Phase 2/3). ✅

**Status:** web build + 58 tests green; **Android not yet compiled/device-tested.**

**Exit criteria:** heatmap on the home screen reflects completions within one app
foreground cycle; survives reboot (re-renders from persisted snapshot).

### Phase 1 — Exact-alarm overdue notifications (Path A) — ✅ BUILT (PR #126)

As-built notes: the plugin (`@capacitor/local-notifications@8.2.0`) already ships
`POST_NOTIFICATIONS`, `RECEIVE_BOOT_COMPLETED`, and a boot-restore receiver, so
**reboot re-registration is free** — we only added `SCHEDULE_EXACT_ALARM`.
`allowWhileIdle: true` maps to `setExactAndAllowWhileIdle` when the exact-alarm
permission is granted, so Path A meets the Doze bar and **Path B was not needed**.
Reminders are single-shot at the future overdue instant (`last + cadence`);
already-overdue chores are left to the in-app toast (we don't schedule a past
`at`). The exact-alarm prompt fires lazily/once, only when there's a reminder to
schedule. Files: `src/native/reminders.ts`, `src/hooks/useReminders.ts`,
`src/utils/seasonal.ts` (extracted), plus guards in `useNotifications.ts`.
Known v1 gaps to revisit: a reminder whose trigger falls outside the seasonal
window still schedules; already-overdue chores get no closed-app nudge.

**Goal:** replace the WebView-timer notifications that silently don't fire when
closed (`useNotifications.ts:106` is the exact "fire from JS loop" anti-pattern
dayGLANCE's war story warns about).

- Add **`@capacitor/local-notifications`**. Verify it schedules with
  `allowWhileIdle` / exact delivery; if it can't guarantee
  `setExactAndAllowWhileIdle`, fall back to Path B (custom Kotlin) for the alarm
  layer only.
- New `src/native/reminders.ts`: compute the eligible set (section 2), build the
  payload (3c), call `syncReminders` (diff-replace). Re-run on the same triggers
  as the snapshot.
- Keep `useNotifications.ts`'s in-app branch (toast when
  `visibilityState === 'visible'`) — that loop stays for in-app toasts/sound
  only; native owns closed-app delivery. Remove its closed-app
  `fireBrowserNotification` path on native.
- **Permissions / manifest:** `POST_NOTIFICATIONS` (runtime, API 33+),
  `SCHEDULE_EXACT_ALARM` (declared **and** actively prompted via
  `ACTION_REQUEST_SCHEDULE_EXACT_ALARM` — the prompt is load-bearing),
  `RECEIVE_BOOT_COMPLETED` (re-register alarms on reboot — they don't survive it),
  notification channel created at app start.
- Tap → `lastglance://chore/<syncId>`.

**Exit criteria:** kill the app, advance a chore past its cadence, alarm fires on
time (test on Doze via `adb shell dumpsys deviceidle force-idle`).

### Phase 2 — Action widgets + optimistic tap-to-complete

**Goal:** the marquee widgets, with completion that *feels instant* and is
*safe*.

- **Overdue/"Soon" list widget** (Glance `LazyColumn` from `snapshot.chores`
  filtered to `state ∈ {soon, overdue}`) and **single-chore widget** (configurable
  `choreSyncId`). Both styled to read as the same family as the in-app `ChoreRow`
  (recency color bar + elapsed text); lucide icons shipped as vector drawables.
- **Tap-to-complete, two layers:**
  1. *Perceived* (pure native, instant): tap handler mutates the snapshot entry
     (→ "just now", green) and re-renders the widget. No WebView, no delay.
  2. *Durable* (idempotent queue): the **native side mints the completion's
     `sync_id` (UUID)** and enqueues `{ choreSyncId, syncId, completedAt }`. JS
     drains on next foreground and replays via
     `logCompletion(choreId, { syncId })` — which **already accepts a caller
     `syncId`** (`db/queries.ts:228`), making it idempotent and CRDT-safe even if
     drained twice or synced from two devices.
- Completion is **silent** — no need to foreground the app (an improvement over
  dayGLANCE's "Mark Complete" which calls `startActivity`).

**Exit criteria:** tapping complete on the widget updates it immediately offline;
reopening the app shows exactly one completion logged; no double-count across a
sync round-trip.

### Phase 3 — Notifications actions, shortcuts, (optional) background sync

- **Actionable notifications:** "Mark done" / "Open" action buttons → emit the
  same `lastglance://complete|chore` intents through the Phase 2 queue. Mostly
  wiring once the router exists.
- **App shortcuts** (`res/xml/shortcuts.xml`): "Soon", "Log a chore" → navigate
  intents.
- **Background CRDT sync (stretch):** the only feature needing a background data
  runtime. Forces the headless-JS-vs-native-mirror decision. Defer until there's
  real demand; current "sync on open" is unchanged behavior.

---

## 5. Path A vs Path B

- **Path A (chosen):** `@capacitor/local-notifications` for the alarm/notification
  primitive; replicate dayGLANCE's *model* on top (absolute-time scheduling,
  diff-set, exact-alarm prompt, idempotent ids). Least native code,
  Capacitor-idiomatic.
- **Path B (backup):** port dayGLANCE's custom Kotlin (`NotificationBridge` /
  `ReminderReceiver` / boot re-registration) into the `WidgetBridge` plugin.
  Maximum control, proven exact behavior, more code to maintain.

**Fall back to B if** Path A can't guarantee `setExactAndAllowWhileIdle`-grade
timing under Doze, doesn't expose the exact-alarm permission flow, doesn't
survive reboot reliably, **or** OEM-killer testing proves we need the WorkManager
re-arm backstop (see §6 — that backstop needs native ownership of the alarm set,
which Path A doesn't provide). The snapshot bridge, widgets, and router are
identical either way — only the alarm layer swaps.

---

## 6. Open questions / risks

- **Widget ↔ ChoreRow visual parity:** DECIDED — aim for **"clearly same family"**
  (cheap), not pixel-parity (ongoing maintenance: fonts, color bar, icon set as
  vectors). Revisit per widget after seeing it on-device.
- **OEM background killers** (Samsung/Xiaomi) can clear alarms. dayGLANCE now
  defends with a 15-min WorkManager backstop that **re-registers task reminders**
  (its earlier version only re-armed widgets/Up-Next). The pattern to copy:
  - One shared, **idempotent** `reregisterPersistedReminders()` that reads the
    same persisted `scheduledReminders` JSON that `syncReminders` maintains,
    skips already-fired entries, and re-schedules with `FLAG_UPDATE_CURRENT`
    keyed on `id.hashCode()` — so repeated runs update alarms in place and
    **never resurrect one the JS layer cancelled**.
  - Both the `BOOT_COMPLETED` receiver and the 15-min `WidgetUpdateWorker`
    delegate to that one method (no duplicated re-registration loop).
  - **A-vs-B implication:** this backstop requires native code that *owns the
    persisted alarm set and can re-register it without JS*. That's a Path B
    trait. With Path A (`@capacitor/local-notifications`) the plugin owns
    scheduling state and survives reboot itself, but does **not** expose a
    "re-register the set" hook a WorkManager job could call — so true OEM-killer
    resilience pulls toward owning the alarm layer (B) or a hybrid that keeps our
    own persisted reminder JSON + native re-register. Keep the agreed posture:
    don't build the backstop until on-device testing shows alarms actually get
    cleared; if it does, treat that as a concrete signal to move the alarm layer
    to B.
- Battery-optimization exemption prompt: intentionally **not** planned for v1
  (intrusive, Play-policy-sensitive, off-brand). Reconsider only if testing on
  real OEM devices proves `setExactAndAllowWhileIdle` + the backstop insufficient.
- **Timezone/DST:** dayGLANCE has no `TIMEZONE_CHANGED` receiver and re-syncs on
  open — a known gap. Cheap to add a receiver that re-runs `syncReminders`.
- **Snapshot freshness while closed:** elapsed time keeps moving but the snapshot is
  static; a daily (midnight) WorkManager/AlarmManager re-render keeps "Xd ago"
  honest without polling.

---

## 7. File touch list (first two phases)

**Phase 0 — as built (Java, not Kotlin; RemoteViews, not Glance):**
- `android/app/src/main/java/com/lastglance/app/WidgetBridgePlugin.java` ✅
- `android/app/src/main/java/com/lastglance/app/SharedDataStore.java` ✅
- `android/app/src/main/java/com/lastglance/app/HeatmapWidgetProvider.java` ✅
- `android/app/src/main/res/layout/widget_heatmap.xml`, `res/xml/heatmap_widget_info.xml`,
  `res/drawable[-night]/widget_background.xml`, `res/values[-night]/colors.xml` ✅
- `src/native/widgetBridge.ts`, `src/native/snapshot.ts`,
  `src/hooks/useWidgetSnapshot.ts` ✅
- Modified: `MainActivity.java` (registerPlugin), `AndroidManifest.xml` (receiver),
  `res/values/strings.xml`, `src/App.tsx` (call `useWidgetSnapshot()`) ✅

**Phase 1+ — still to come:**
- `src/native/reminders.ts` (eligible-set + `syncReminders`)
- `capacitor.config.ts` (LocalNotifications config if needed)
- `src/hooks/useNotifications.ts` (keep in-app toast branch; drop closed-app web
  notification on native)
- `AndroidManifest.xml` (POST_NOTIFICATIONS, SCHEDULE_EXACT_ALARM, BOOT_COMPLETED)
- `package.json` (`@capacitor/local-notifications`)
- If Path B: a Glance `widget/` package for the interactive Phase 2 widgets
```
