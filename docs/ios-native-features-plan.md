# iOS Native Features — Implementation Plan

Widgets, actionable notifications, shortcuts, and a share target for the
lastGLANCE **iOS** app. This is the iOS counterpart to
`docs/android-native-features-plan.md`; that document's architecture was chosen
to be cross-platform, so this plan reuses the shared JS layer and data contracts
and only reimplements the native rendering per platform.

> **▶ STATUS (last updated 2026-07-12)**
> **Not started. Only the stock Capacitor iOS shell exists.**
>
> - Present today: default `AppDelegate.swift`, the Capacitor SPM package, and a
>   default `Info.plist`. **No custom Swift, no widget extension, no App Group, no
>   entitlements.** `@capacitor/ios` is installed, so the web app runs in the iOS
>   WebView, but zero native features are wired.
> - All native JS is hard-gated to `getPlatform() === 'android'` (12 guards, 0 iOS
>   branches), so even the cross-platform notification layer does not run on iOS.
> - Android, by contrast, is feature-complete (Phases 0-3). Bringing iOS up is
>   **additive**: the shared JS/design layer does not change, only the native
>   declarations and rendering are added.

---

## 1. The iOS prerequisite: an App Group

On Android the native side reads a JSON snapshot from `SharedPreferences` and a
pending-action queue from the same store. On iOS the equivalent shared container
between the main app and its widget/share extensions is an **App Group**
(`group.app.lastglance`). Every native feature below reads or writes that
container, so it is the first thing to stand up and it gates everything else.

- Requires an Apple Developer account, an App Group capability added to the app
  target and each extension target, and matching provisioning profiles.
- The shared store is `UserDefaults(suiteName: "group.app.lastglance")` for small
  JSON (snapshot, queues) and the App Group's file container for anything larger
  (rasterized icons). This mirrors the Android `SharedDataStore` split.

---

## 2. What carries over from Android (no rewrite)

The decision logic lives in JS behind a thin Capacitor-plugin boundary, the
snapshot is a plain JSON contract, and navigation goes through one
`lastglance://` router. Reusable as-is:

- **`src/native/snapshot.ts`** — the snapshot JSON. iOS widgets read the same
  contract (section 3b of the Android plan).
- **`src/native/reminders.ts`** scheduling model — eligibility, diff-replace,
  action types, body text. Built on `@capacitor/local-notifications`, which is
  cross-platform.
- **`src/native/pendingCompletions.ts` + `usePendingCompletions`** — the drain
  that replays native-minted completions via `logCompletion(choreId, { syncId })`
  (idempotent on a caller-supplied `sync_id`).
- **`pendingDeepLink.ts` / `pendingOpenChore.ts`** routing, the
  `@glance-apps/intents` action router, and the user-attribution and
  dayGLANCE-gating logic.

Only the code below is reimplemented in Swift: the WidgetBridge plugin, the
widgets, the interactive completion mechanism, the chore-icon assets, and the
per-platform entry-point declarations (deep links, shortcuts, share target).

---

## 3. Phases

### Phase 0 — App Group + WidgetBridge Swift plugin (the spine)

**Goal:** prove the read path end to end with zero write-back risk, exactly like
Android Phase 0.

- Add the **App Group** capability + `App.entitlements` to the app target.
- New **Swift Capacitor plugin `WidgetBridge`** exposing the same JS interface the
  Android plugin does, so `src/native/widgetBridge.ts` wrappers are unchanged:
  `updateSnapshot({ json })`, `getPendingActions()`, `clearPendingActions({ ids })`,
  `drainPendingCompletions()`, `consumeDeepLink()`. Reads/writes the App Group
  container.
- A minimal **WidgetKit** extension target that renders the heatmap from
  `snapshot.heatmap` (static, non-interactive) to validate the App-Group read and
  light/dark handling.
- **Relax the JS guards**: introduce an `isIOS()` helper and let the snapshot push
  path run on iOS (`getPlatform() === 'android' || 'ios'`), starting with
  `widgetBridge.ts` and `useWidgetSnapshot.ts`.

**Exit criteria:** the heatmap widget on the home screen reflects completions
within one app foreground cycle and survives relaunch (re-renders from the
persisted App-Group snapshot).

### Phase 1 — Overdue notifications (mostly portable)

`@capacitor/local-notifications` already works on iOS, so this is the cheapest
win. The Android plan estimates it ~70-80% portable.

- Relax the Android-only guards in `useReminders.ts` / `reminders.ts` /
  `useNotifications.ts` to include iOS.
- Handle **iOS specifics**: no exact-alarm permission prompt (drop that branch on
  iOS); the app icon is used instead of a monochrome `smallIcon`; the **64
  pending-notification cap** (our single-shot-per-chore model stays well under it,
  but cap defensively); actions declared as `UNNotificationCategory` (the plugin
  abstracts this) with the same "Mark done" / "Send to dayGLANCE" verbs.
- Delivery timing note: iOS has no `setExactAndAllowWhileIdle` equivalent; the
  system may batch delivery. This fits the "information, not guilt" single-shot
  model, but timing is inherently less precise than Android exact alarms. Accept
  for v1.

**Exit criteria:** kill the app, advance a chore past its cadence, the overdue
notification fires and its tap routes to the chore.

### Phase 2 — WidgetKit widgets + tap-to-complete

The big lift. ~0% code reuse from Kotlin, but the data contract and layout design
carry over.

- **WidgetKit + SwiftUI** widgets reading the App-Group snapshot: heatmap,
  soon/overdue **list** widget, and a configurable **single-chore** widget.
  A `TimelineProvider` supplies entries; use SwiftUI relative-date text so
  "Xd ago" stays honest between snapshot pushes without a background runtime.
- **Interactive tap-to-complete via AppIntents (iOS 17+)**: the Done button runs
  an `AppIntent` that writes `{ choreSyncId, syncId, completedAt }` to the
  App-Group completion queue and optimistically mutates the snapshot entry. JS
  drains on next foreground through the **existing** `pendingCompletions` path.
  Decide the minimum iOS version; pre-17 devices fall back to tap-to-open.
- **Chore icons**: the Lucide *Android vector drawables* do not port. Rasterize
  the Lucide SVGs to PNGs into the App Group (adapt
  `scripts/gen-lucide-drawables.mjs` to emit PNG assets), tinted to the recency
  color. Decide this up front; it blocks icon parity.
- Style to read as the same family as the in-app `ChoreRow` (recency color bar +
  elapsed text), matching the Android "clearly same family" posture.

**Exit criteria:** tapping Done on the widget updates it immediately offline;
reopening the app shows exactly one completion logged; no double-count across a
sync round-trip.

### Phase 3 — Entry points: deep links, shortcuts, share extension

- **Deep-link capture**: widget body-taps use SwiftUI `widgetURL` /
  `Link(destination:)` with `lastglance://chore/<syncId>` and
  `lastglance://filter/soon`; the app handles the URL in the Scene/AppDelegate and
  stashes the target in the App Group, consumed on foreground by the existing
  `consumeDeepLink` -> `routeWidgetDeepLink` path.
- **Shortcuts**: `UIApplicationShortcutItem` (Home-screen long-press) and/or
  **App Shortcuts via AppIntents** (Spotlight/Siri), targeting the same
  `lastglance://` verbs as the Android dynamic shortcuts (Add chore, Search,
  top-overdue chores, Soon).
- **Share Extension**: an `NSExtension` share target writing shared text/links to
  the App Group (`pending_shared_chore`, preferring a title over the raw URL),
  consumed on foreground by the existing `consumeSharedChore` to open the
  new-chore form pre-filled. This is the direct analog of the Android share
  target and reuses the same web prefill.
- **Stretch:** Lock Screen / Control Center widgets (WidgetKit accessory families)
  are the closest analog to the Android Quick Settings tiles; optional.

There is **no iOS analog planned for background CRDT sync** (same as Android:
out of scope; reconcile on next foreground).

---

## 4. iOS-specific risks & decisions

- **App Group provisioning** is the critical-path setup: developer account,
  entitlement on every target, matching profiles. Nothing else works until it is
  in place.
- **WidgetKit is not a live process.** Timelines refresh on a system budget, so
  there is no arbitrary background execution. The snapshot-read model fits, but
  freshness of relative time ("Xd ago") relies on TimelineProvider entries and/or
  SwiftUI relative-date formatting rather than polling.
- **AppIntents interactivity is iOS 17+.** Pick a minimum deployment target; older
  devices get tap-to-open widgets only.
- **64 pending local notifications** system cap; stay under it (our model does).
- **No exact-alarm timing.** Delivery may be batched; acceptable for the
  single-shot overdue model, but call it out to avoid a "why is it late" surprise.
- **Icon pipeline decision up front:** rasterize Lucide SVGs to App-Group PNGs
  (recommended, reuses the set-aside Android approach) vs render SVGs in SwiftUI.

---

## 5. File touch list (proposed)

**Native (new, Swift):**
- `ios/App/App/App.entitlements` — App Group capability (+ matching entitlement on
  each extension target).
- `ios/App/App/plugins/WidgetBridgePlugin.swift` (+ Capacitor registration) — the
  Swift `WidgetBridge`.
- `ios/App/GlanceWidgets/` — WidgetKit extension: SwiftUI views, `TimelineProvider`,
  `AppIntent` completion action, App-Group store helper.
- `ios/App/ShareExtension/` — share target writing to the App Group.
- `ios/App/App/AppDelegate.swift` (or a Scene delegate) — `lastglance://` URL
  handling; `UIApplicationShortcutItem` wiring if not using AppIntents.
- `ios/App/App/Info.plist` — `CFBundleURLTypes` for `lastglance://`, notification
  usage strings.

**Shared JS (small edits, no behavior change):**
- `src/native/widgetBridge.ts`, `src/hooks/useWidgetSnapshot.ts`,
  `src/native/reminders.ts`, `src/hooks/useReminders.ts`,
  `src/hooks/useNotifications.ts` — relax the `=== 'android'` guards to include
  iOS; add an `isIOS()` helper alongside `isAndroid()`.
- `scripts/gen-lucide-drawables.mjs` — add a PNG-emitting mode for iOS icons (or a
  sibling script).

**To stay iOS-friendly going forward:** keep decision logic in JS behind the
plugin boundary; route every new entry point through the shared `lastglance://`
router so only the native declaration is per-platform; keep the App Group as the
single native shared store.
