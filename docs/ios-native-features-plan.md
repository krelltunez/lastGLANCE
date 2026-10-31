# iOS Native Features — Implementation Plan

Widgets, actionable notifications, shortcuts, and a share target for the
lastGLANCE **iOS** app. This is the iOS counterpart to
`docs/android-native-features-plan.md`; that document's architecture was chosen
to be cross-platform, so this plan reuses the shared JS layer and data contracts
and only reimplements the native rendering per platform.

> **▶ STATUS (last updated 2026-10-31)**
> **Feature-complete.** Every phase of this plan, the stretch goals it
> deferred, and the three follow-ons its August status held open are built and
> merged. iOS has parity with the Android native feature set and exceeds it in
> several places. Phases 0-3 were confirmed on a physical iPad via TestFlight
> in August; what landed after that is listed below with what remains unseen on
> a device.
>
> - **Phase 0** ✅ App Group `group.com.lastglance`, WidgetBridge Swift plugin,
>   snapshot push/read verified end to end.
> - **Phase 1** ✅ Overdue notifications deliver; "Mark done" runs HEADLESS on
>   iOS (the plugin retains the background action and replays it on next launch)
>   — better than Android, which opens the app.
> - **Phase 2** ✅ Heatmap (medium 26wk / extra-large 52wk with labels, legend,
>   stats), Soon list (ViewThatFits row adaptation; no scrolling exists in
>   WidgetKit), configurable single-chore widget, one-tap Done via AppIntents
>   with optimistic snapshot fold + idempotent replay. Icons via the generated
>   Lucide path pipeline (`npm run gen:icons:ios`).
> - **Phase 3** ✅ `lastglance://` deep links, home-screen quick actions rebuilt
>   from each snapshot push (SF-symbol icons — the legacy `.task` enum renders
>   "?"), AddChoreWidget, and the share extension: instant save + confirmation
>   card (lifeGLANCE's pattern), with `pending_shared_chore` as a QUEUE because
>   iOS cannot bring the app forward on share — a slot would drop all but the
>   last of several queued shares.
> - **The three follow-ons August left open, all now shipped:**
>   Keychain-backed SecureStore (`plugins/SecureStorePlugin.swift`,
>   `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so credentials are no
>   longer plaintext in WebView storage); the accessory widgets
>   (`AccessoryWidgets.swift` for circular/rectangular/inline,
>   `NextDateAccessoryWidget` for People, and `AddChoreControl` as an iOS 18
>   Control Center control, which is the Quick Settings tiles' analogue); and
>   App Store billing — **via RevenueCat, not the raw StoreKit half this plan
>   assumed** (`plugins/BillingBridgePlugin.swift` + `RevenueCatBilling.swift`,
>   same JS contract as the Android plugin so `src/billing/billing.ts` drives
>   both stores with no iOS-specific JS).
> - **Arrived after this plan was written, none of it contemplated here:**
>   zero-config iCloud sync and iCloud intents (`docs/icloud-sync.md`); Direct
>   Access on iOS, as security-scoped bookmarks per file since the Files
>   providers cannot hand an app a folder (`docs/direct-access.md`); phone
>   contacts and the People widgets; the Pinned widget; the week-start setting;
>   a Release-build guard that refuses a Safari-inspectable config; and a CI job
>   that compiles the app for the Simulator on every PR that can affect it.
> - **App Shortcuts (2026-10):** `App/ChoreShortcuts.swift` puts the four verbs
>   of the Android intents bridge into Siri, Spotlight and the Shortcuts app —
>   mark done and "when did I last" run headless off the App-Group snapshot and
>   queue, add and show-soon open the app. Gated at iOS 17.0 like the widget
>   extension. This is what Phase 3's "Shortcuts" bullet left as an either/or.
> - **Where iOS now leads Android:** headless "Mark done" from a notification;
>   the 52-week extra-large heatmap on iPad; a midnight timeline refresh so
>   "Xd ago" stays honest while the app is closed, which the Android plan still
>   lists as an open gap; and Shortcuts/Siri, which has no Android counterpart
>   beyond the Tasker bridge.
> - **No iOS counterpart, by platform shape rather than omission:** the launcher
>   provider and its headless refresh (`docs/launcher-integration.md`), the
>   Tasker broadcast intents bridge (App Shortcuts is the analogue), and exact
>   alarms.
> - **Portal state:** App Group enabled on all three App IDs (`com.lastglance`,
>   `.GlanceWidgets`, `.ShareExtension`). The two iCloud containers are on
>   `com.lastglance`; note that is the iOS bundle ID, not the Android
>   application ID `com.lastglance.app`, which is not an App ID at all.
> - **Operational notes that outlived their PRs:** reboot the device before
>   believing a widget bug (WidgetKit caches survive reinstalls); quick actions
>   refresh on snapshot push, not install; `IOS_BUILD=<n> npm run cap:ios` sets
>   the build number for all three targets through the gitignored
>   `ios/version.generated.xcconfig`, never in `project.pbxproj`.
> - **Siri phrases are `.strings`, not a String Catalog.** Everything else the
>   app target localizes lives in `App/Localizable.xcstrings`, but
>   `appshortcutstringsprocessor` rejects an `AppShortcuts.xcstrings` outright
>   whenever the app target deploys below iOS 17, and this one stays at 15.0.
>   So the phrases are `App/<lang>.lproj/AppShortcuts.strings`, carried by a
>   PBXVariantGroup, and are the only `.lproj` folders in the project. Keys are
>   the English phrase with `${applicationName}` where the Swift interpolates
>   `\(.applicationName)`.
> - **Not yet seen on a device:** the purchase flows (the App Store products
>   and the paywall's store-aware copy). CI cannot reach them: billing is
>   store-side.

---

## 1. The iOS prerequisite: an App Group

On Android the native side reads a JSON snapshot from `SharedPreferences` and a
pending-action queue from the same store. On iOS the equivalent shared container
between the main app and its widget/share extensions is an **App Group**
(`group.com.lastglance`). Every native feature below reads or writes that
container, so it is the first thing to stand up and it gates everything else.

- Requires an Apple Developer account, an App Group capability added to the app
  target and each extension target, and matching provisioning profiles.
- The shared store is `UserDefaults(suiteName: "group.com.lastglance")` for small
  JSON (snapshot, queues) and the App Group's file container for anything larger.
  This mirrors the Android `SharedDataStore` split.
- The identifier follows the iOS bundle ID (`com.lastglance`), **not** the Android
  application ID (`com.lastglance.app`) — the two have never matched. An earlier
  draft of this plan said `group.app.lastglance`, which matches neither.
- A wrong or unprovisioned group fails **silently**: `UserDefaults(suiteName:)`
  returns nil and every read looks like a fresh install. `SharedDataStore.isAvailable`
  exists so `updateSnapshot` can reject loudly instead.

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
  Android plugin does, so `src/native/widgetBridge.ts` wrappers are unchanged.
  The interface is exactly four methods — `updateSnapshot({ json })`,
  `drainPendingCompletions()`, `consumeDeepLink()`, `consumeSharedChore()`.
  (An earlier draft listed `getPendingActions` / `clearPendingActions`; those have
  never existed on either platform.) Reads/writes the App Group container.
- A minimal **WidgetKit** extension target that renders the heatmap from
  `snapshot.heatmap` (static, non-interactive) to validate the App-Group read and
  light/dark handling.
- **Relax the JS guards**: introduce an `isIOS()` helper and let the snapshot push
  path run on iOS, starting with `widgetBridge.ts` and `useWidgetSnapshot.ts`.

**Exit criteria:** the heatmap widget on the home screen reflects completions
within one app foreground cycle and survives relaunch (re-renders from the
persisted App-Group snapshot).

**First-build checklist** (the parts that cannot be done from the repo):

1. Apple Developer portal: add the App Group `group.com.lastglance`, then enable
   it on the App IDs `com.lastglance` and `com.lastglance.GlanceWidgets`.
2. Open `ios/App/App.xcodeproj` and confirm the hand-written
   `GlanceWidgetsExtension` target appears with its five files, and that Signing &
   Capabilities shows App Groups ticked on **both** targets.
3. `npm run build:ios`, then Run. `cap sync` only touches web assets and the SPM
   package, so it will not disturb the new target. It also runs
   `sync-ios-version.mjs`, which rewrites `MARKETING_VERSION` in all four build
   configs — expect that diff.
4. Plugin registration is already handled: `BridgeViewController.capacitorDidLoad()`
   registers `WidgetBridgePlugin` alongside `VaultSsePlugin`, and
   `Main.storyboard` instantiates that subclass. If `WidgetBridge` still comes
   back undefined in JS, check the storyboard's `customClass` first — that wiring
   is the single point of failure for both plugins.

### Phase 1 — Overdue notifications (mostly portable)

`@capacitor/local-notifications` already works on iOS, so this is the cheapest
win. The Android plan estimates it ~70-80% portable.

- Relax the Android-only guards in `useReminders.ts` / `reminders.ts` /
  `useNotifications.ts` to include iOS. **Done 2026-08** (untested on device).
  The scheduling model is shared; four things are platform-conditional, all of
  them inside `reminders.ts`:
  - `ensureChannel` — Android-only; channels have no iOS equivalent.
  - `maybePromptExactAlarm` — Android-only; iOS has no exact-alarm permission.
  - the per-build force-reschedule — Android-only. The hazard is aapt2
    reassigning drawable resource IDs between builds; iOS notifications carry no
    resource ID, so forcing it there would churn every pending notification on
    each build to fix a problem it cannot have.
  - the 64-notification cap — iOS-only; see below.
  **Device-verified 2026-08:** delivery works, and notification actions came out
  BETTER than planned — on iOS "Mark done" does not foreground the app at all;
  the plugin retains the action and replays it on next launch, where the
  existing drain logs it. That is the headless completion the plan assumed was
  impossible, courtesy of the plugin's retained-action path. Android still
  opens the app (its plugin behavior); the divergence favours iOS and needs no
  code.
- Handle **iOS specifics**: no exact-alarm permission prompt (drop that branch on
  iOS); the app icon is used instead of a monochrome `smallIcon`; the **64
  pending-notification cap**; actions declared as `UNNotificationCategory` (the
  plugin abstracts this) with the same "Mark done" / "Send to dayGLANCE" verbs.
- On the cap: implemented as `soonest(all, 56)`, not 64. The limit is **per app,
  not per feature**, so scheduling right up to it would make some future
  notification of another kind the one iOS silently discards. When the cap bites,
  the reminders kept are the nearest-firing — everything dropped is further out
  than everything kept, and each later sync (foreground, completion, sync-apply)
  pulls the next tranche in as the near ones fire. No `smallIcon` handling was
  needed: it is set in `capacitor.config.ts` and simply ignored on iOS.
- Delivery timing note: iOS has no `setExactAndAllowWhileIdle` equivalent; the
  system may batch delivery. This fits the "information, not guilt" single-shot
  model, but timing is inherently less precise than Android exact alarms. Accept
  for v1.

**Exit criteria:** kill the app, advance a chore past its cadence, the overdue
notification fires and its tap routes to the chore.

### Phase 2 — WidgetKit widgets + tap-to-complete

The big lift. ~0% code reuse from Kotlin, but the data contract and layout design
carry over.

> **Status 2026-08: written, unbuilt.** SoonListWidget, SingleChoreWidget
> (configurable via `AppIntentConfiguration` — no config Activity needed on iOS),
> CompleteChoreIntent + CompletionStore mirroring the Kotlin completion contract
> field for field (lowercase-UUID sync_id minted at tap time, millisecond-UTC
> completedAt, optimistic snapshot fold with counts recompute and heatmap bump).
> The optimistic fold mutates the raw JSON via JSONSerialization, NOT the Codable
> model — the model is lenient/lossy by design and a round trip would drop fields
> this build does not know. One divergence from Android: WidgetKit lists do not
> scroll, so rows are capped per family with a "+N more" line instead.

- **WidgetKit + SwiftUI** widgets reading the App-Group snapshot: heatmap,
  soon/overdue **list** widget, and a configurable **single-chore** widget.
  A `TimelineProvider` supplies entries; use SwiftUI relative-date text so
  "Xd ago" stays honest between snapshot pushes without a background runtime.
- **Heatmap families (decided 2026-08, verified on device):** `systemMedium` is
  26 weeks, bare grid; `systemExtraLarge` is 52 weeks with month/weekday labels
  and a Less→More legend. **`systemLarge` is deliberately unsupported.** A 52x7
  grid of square cells is ~7.4:1, so in a square family it renders as a band with
  two thirds of the height empty and nothing worth putting there; extra-large is
  ~2:1 and carries it. Cell size works out at ~10.9pt on extra-large versus
  ~10.1pt for medium's 26 weeks, so the full year is *more* legible, not less.
  Note extra-large is **iPad-only** — WidgetKit has never offered it on iPhone,
  so iPhone gets medium alone. Android stays at 26 weeks; the split is accepted
  (its heatmap has no extra-large analogue to diverge from).
- **Interactive tap-to-complete via AppIntents (iOS 17+)**: the Done button runs
  an `AppIntent` that writes `{ choreSyncId, syncId, completedAt }` to the
  App-Group completion queue and optimistically mutates the snapshot entry. JS
  drains on next foreground through the **existing** `pendingCompletions` path.
  The deployment target is settled (see section 4): the extension is 17.0, so
  there is **no pre-17 fallback path to build**.
- **Chore icons**: the Lucide *Android vector drawables* do not port. Settled
  approach is a generated Swift file of Lucide path data plus a small
  SVG-path-to-`SwiftUI.Path` parser — see section 4 for why rasterising to
  App-Group PNGs was rejected. **This blocks the list and single-chore widgets**,
  which are icon-bearing; the heatmap needed no icons, which is why it shipped
  first.
- Style to read as the same family as the in-app `ChoreRow` (recency color bar +
  elapsed text), matching the Android "clearly same family" posture.

**Exit criteria:** tapping Done on the widget updates it immediately offline;
reopening the app shows exactly one completion logged; no double-count across a
sync round-trip.

### Phase 3 — Entry points: deep links, shortcuts, share extension

> **Status 2026-08: everything except the share extension written, unbuilt.**
> `CFBundleURLTypes` declares `lastglance://`; AppDelegate maps URLs to the
> internal tokens (mirroring `MainActivity.linkFromUri`) and handles quick-action
> taps, whose item `type` IS the token. WidgetBridgePlugin rebuilds the quick
> actions from each snapshot push (Add, Search, top-2 overdue — iOS caps at 4,
> the same lowest-priority-first trim Android applies). Widget body-taps carry
> `widgetURL`/`Link`s: heatmap → Soon, list rows → their chore (Done buttons stay
> outside the Link so the AppIntent keeps the tap), single-chore → its chore,
> AddChoreWidget → the new-chore form. `usePendingDeepLink` runs in both shells.

- **Deep-link capture**: widget body-taps use SwiftUI `widgetURL` /
  `Link(destination:)` with `lastglance://chore/<syncId>` and
  `lastglance://filter/soon`; the app handles the URL in the Scene/AppDelegate and
  stashes the target in the App Group, consumed on foreground by the existing
  `consumeDeepLink` -> `routeWidgetDeepLink` path.
  Note what gets stored: `routeWidgetDeepLink` expects the **internal token**
  form, not the URL — `chore:<syncId>`, `filter:soon`, `action:search`,
  `action:add`. The URL is mapped to a token before it is written, exactly as
  `MainActivity.toDeepLinkToken` does on Android.
- **Shortcuts**: `UIApplicationShortcutItem` (Home-screen long-press) and/or
  **App Shortcuts via AppIntents** (Spotlight/Siri), targeting the same
  `lastglance://` verbs as the Android dynamic shortcuts (Add chore, Search,
  top-overdue chores, Soon).
  **Both, in the end (2026-10).** The quick actions shipped with the rest of
  Phase 3; App Shortcuts came later, in `App/ChoreShortcuts.swift`, and are
  the iOS answer to the Android broadcast intents bridge rather than to the
  dynamic shortcuts: same four verbs (CREATE, COMPLETE, QUERY, OPEN), with
  COMPLETE and QUERY running headless off the App-Group snapshot and queue.
  A `ChoreEntity` + `EntityStringQuery` over the snapshot is what lets Siri
  match a chore the user *said*. The file is a member of the **app target
  only**: App Shortcuts are read out of the app's AppIntents metadata, and an
  intent vended by both targets appears twice in the Shortcuts list, which is
  why the widget's `CompleteChoreIntent` and the control's `OpenAddChoreIntent`
  are `isDiscoverable = false`. That membership is also why `Snapshot.swift`
  and `CompletionStore.swift` are compiled into both targets.
- **Share Extension**: an `NSExtension` share target writing shared text/links to
  the App Group (`pending_shared_chore`, preferring a title over the raw URL),
  consumed on foreground by the existing `consumeSharedChore` to open the
  new-chore form pre-filled. This is the direct analog of the Android share
  target and reuses the same web prefill.
  **Status 2026-08: written, unbuilt** — `ios/App/ShareExtension/` target
  (`com.lastglance.ShareExtension`, deployment 15.0, SLComposeServiceViewController).
  ⚠ **Portal prerequisite:** the App Group must be enabled on this THIRD App ID
  too — `com.lastglance.ShareExtension` joins `com.lastglance` and
  `com.lastglance.GlanceWidgets`. Without it the extension builds and runs but
  every save silently vanishes (`UserDefaults(suiteName:)` returns nil).
  **Redesigned 2026-08 after device testing, adopting lifeGLANCE's proven
  pattern:** no compose sheet — the share saves immediately and a confirmation
  card ("Saved to lastGLANCE" + the captured name) is the only UI. The
  Add-chore form the share opens on next foreground is already an edit step,
  so the sheet was a second copy of it. Two structural facts drive the design:
  iOS bars extensions from opening their host app (the responder-chain openURL
  trick died in iOS 18, by design), and because the app is NOT brought forward,
  `pending_shared_chore` is a **queue, not a slot** — Android's slot is right
  there only because its share opens the app and drains it instantly. The JS
  drain pops one name per foreground, so multiple queued shares surface across
  subsequent opens, oldest first. The principal class is the bare
  `ShareViewController` paired with `@objc(ShareViewController)` — lifeGLANCE's
  battle-tested combination; if the attribute is removed the plist key must
  revert in the same commit.
- **Add-chore widget**: Android ships `glance/AddChoreWidget.kt`, a static
  one-tap surface with no snapshot dependency. Earlier drafts of this plan had no
  iOS counterpart — an oversight, not a decision. On iOS it is a `systemSmall`
  widget whose only job is a `widgetURL` of `action:add`, so it belongs here with
  the other entry points rather than in Phase 2 with the data-bearing widgets.
- **Stretch, since done:** Lock Screen / Control Center widgets (WidgetKit
  accessory families) are the closest analog to the Android Quick Settings tiles
  (`tiles/QsTiles.kt`, add-chore and soon). `AccessoryWidgets.swift` covers the
  Lock Screen families and `AddChoreControl` the Control Center button, the
  latter in `App/Shared/` because a control's intent must be visible to the app
  target or the tap does nothing at all.

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
- **⚠ Reboot the device before believing a widget bug (learned the hard way,
  2026-08).** WidgetKit caches extension state aggressively and a stale cache
  survives reinstalls, including fresh TestFlight installs. The symptom that cost
  most of a day: the widget rendered perfectly in the gallery, with live data, and
  rendered *nothing at all* once placed on the home screen — not even static text.
  It was not a crash (no `.ips`), not a memory kill (the extension peaked at 3 MB
  against a ~30 MB budget and was never jetsammed), and not a code fault. **A
  reboot fixed it.** Suspect the cache first whenever the gallery and the placed
  widget disagree, especially right after changing `supportedFamilies`, the widget
  `kind`, or the set of widgets in the bundle — changes to a widget's *identity*
  are exactly what the cache gets wrong. Diagnose from the device before changing
  code: a gallery/placed split is a WidgetKit state problem until proven otherwise.
- **AppIntents interactivity is iOS 17+.** Decided 2026-07: the **app target stays
  at iOS 15.0** and the **widget extension targets 17.0**. An extension may set a
  higher floor than its host, so no existing app user is dropped and there is only
  one widget code path — devices below 17 simply are not offered the widgets. No
  pre-17 tap-to-open fallback will be built. App Shortcuts took the same 17.0
  floor in 2026-10, for the same reason: `ChoreShortcuts.swift` is annotated
  rather than the app target's floor being raised.
- **⚠ Not every AppIntents API shares that floor, and the app target's 15.0
  setting will not tell you.** `OpenURLIntent` is **iOS 18+**.
  `AddChoreControl.swift` chains one and compiles fine, because a Control Center
  control is 18-only anyway; the same line in a 17-gated file is a build error,
  which is how it was found (CI, on the App Shortcuts PR). The two
  open-the-app shortcuts therefore chain nothing and rely on the App-Group
  token write alone, which AddChoreControl's own comment already identifies as
  the half that actually carries the destination. Check an AppIntents symbol's
  availability against the annotation on the file you are putting it in, not
  against `IPHONEOS_DEPLOYMENT_TARGET`.
- **Notification actions may not be able to run headless.** On iOS a
  non-`.foreground` `UNNotificationAction` wakes the app process, but the
  Capacitor JS listener only fires if the WebView is alive to run it, so "Mark
  done" may have to open the app.
  **This is less of a fork than it looks:** Android already settled on the same
  compromise — see the Android plan's "silent *Mark done* left opening the app
  (truly background completion needs the Path B alarm layer)". So opening the app
  is parity, not an iOS regression, and it is the right v1 behaviour. Revisit only
  if truly-headless completion becomes a goal on both platforms, in which case the
  iOS answer is an AppIntent writing to the App-Group queue (the Phase 2
  mechanism), not the notification listener.
- **64 pending local notifications** system cap; stay under it (our model does).
- **No exact-alarm timing.** Delivery may be batched; acceptable for the
  single-shot overdue model, but call it out to avoid a "why is it late" surprise.
- **Icon pipeline (decided 2026-07): generate Swift path data.** Extend
  `gen-lucide-drawables.mjs` to emit a Swift source file of Lucide path strings
  plus a small SVG-path-to-`SwiftUI.Path` parser, compiled into the widget bundle.
  Vector-crisp at any size, tintable to the recency colour, a few hundred KB.
  Rejected: rasterizing to App-Group PNGs (the container is runtime-only, so it
  would mean a first-launch write of 1,703 icons x 2 scales, tens of MB, at fixed
  resolution) and bundling them in an asset catalog (same bloat, in the download).

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
- `src/native/platform.ts` (new) — `isAndroid()` / `isIOS()` / `isNativeShell()`.
  Kept separate from the `isAndroid()` in `intentsBridge.ts`, which answers the
  narrower "can this device receive Tasker intents" and will never grow an iOS
  branch.
- `src/native/widgetBridge.ts`, `src/hooks/useWidgetSnapshot.ts`,
  `src/native/reminders.ts`, `src/hooks/useReminders.ts`,
  `src/hooks/useNotifications.ts` — relax the `=== 'android'` guards to include
  iOS.
- `scripts/gen-lucide-drawables.mjs` — add a Swift-path-data mode for iOS icons
  (or a sibling script).
- `scripts/sync-ios-version.mjs` — writes both version numbers to the
  gitignored `ios/version.generated.xcconfig`, which `ios/debug.xcconfig` and
  `ios/release.xcconfig` include at the project level, so all three targets
  inherit them and builds never dirty `project.pbxproj`. `MARKETING_VERSION`
  tracks package.json. `CURRENT_PROJECT_VERSION` (the build number) has to
  increment per **upload**, not per version, so it cannot be derived from
  package.json and is set explicitly: `IOS_BUILD=<n> npm run build:ios`. With
  `IOS_BUILD` unset the last build number written on that machine is kept. The
  script **fails the build** if `project.pbxproj` sets either value, since a
  target-level setting overrides the xcconfig for that target alone, and an app
  and its extensions must ship the same `CFBundleVersion` or App Store Connect
  rejects the upload. Xcode's General tab writes one when Version or Build is
  edited there.

**To stay iOS-friendly going forward:** keep decision logic in JS behind the
plugin boundary; route every new entry point through the shared `lastglance://`
router so only the native declaration is per-platform; keep the App Group as the
single native shared store.
