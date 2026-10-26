# CLAUDE.md

Working notes for AI-assisted sessions in this repo.

## Maintainer context

- **Timezone: America/Denver (Mountain Time).** Phrase all time-of-day
  references ("today", "tonight", deadlines) in Mountain Time, not UTC.
- Release notes must contain **no em dashes**.

## Conventions

- Versioning: `versionName` from package.json; Android `versionCode` is derived
  as `major*1000000 + minor*10000 + patch*100` (see android/app/build.gradle),
  leaving +100 headroom per patch for pre-release `APP_VERSION_CODE` overrides.
- Release builds: `./build-android.sh --release` produces both the sideload APK
  and the Play `.aab`. Upload the bundle once, then promote it between tracks;
  do not rebuild per track.
- Play listing is FREE (locked by Google; cannot become paid). Monetization is
  in-app via Play Billing. The GitHub sideload APK ships without the paywall
  (dayGLANCE-style split).
- Release builds intentionally keep `minifyEnabled false` — do NOT enable R8 or
  `shrinkResources` (decided 2026-07). The native shell is thin (all product
  logic is JS assets R8 never touches, so obfuscation buys ~nothing), Capacitor
  plugin bridges rely on reflection that breaks at runtime only, and the widgets
  resolve the ~1.7k `ic_lucide_*` drawables by name (`getIdentifier`), which
  resource shrinking would strip.

## Google Play (learned the hard way, 2026-07)

- **NEVER create a Play app entry as Free unless it will stay free forever.**
  Free→paid is impossible once the app has been published to ANY track — even
  internal testing counts. Paid→free is allowed (also one-way). New GLANCE app
  entries must be created as PAID; testers install paid apps free via
  Setup → License testing.
- The closed-testing requirement (12 testers opted in for 14 days) is per-app
  and restarts for any new app entry / package name.
- lastGLANCE (`com.lastglance.app`) is locked FREE on Play; monetization is an
  in-app Play Billing unlock. lifeGLANCE reported locked free as well (verify:
  the lock only applies once published to a track). dayGLANCE is free by
  design with its own in-app paywall.

## Headless refresh (the launcher's REFRESH at a dead process)

`android/.../launcher/LauncherRefreshWorker.kt` boots the web bundle in a
WebView with no Activity and no Capacitor bridge; main.tsx runs
`src/headless/headlessRefresh.ts` for it. Design and outcomes:
`docs/launcher-integration.md`, "The headless refresh". The rules:

- **An allowlist.** The run reaches native code only through
  `HEADLESS_BRIDGE_METHODS` (`src/headless/headlessMode.ts`), kept equal to
  `HeadlessBridge.kt`. A module the run needs that calls a Capacitor plugin gets
  a `headlessBridge()` branch (secureStore, nativeHttp, the vault engines'
  `fetchImpl`, launcherBridge are the ones today); anything else stays out of
  the root. `headlessRefresh.scenarios.test.ts` fails on a method outside the list.
- **Same origin, same storage.** The WebView loads `assets/public` at
  `https://localhost`, Capacitor's origin, which is what shares IndexedDB and
  localStorage with the app. Do not move either side off it.
- **Signal-abort.** `MainActivity.onCreate` destroys a run in flight before the
  bridge loads; the root checks `headlessShouldAbort` between phases.
- **Launcher writes are applied, then pushed.** After its roads the run applies
  the launcher's queued writes with the app's own handlers and ledger
  (`src/intents/launcherQueue.ts`), each acknowledged to the native queue only
  once handled, and runs the roads again when any changed something. The
  receiver schedules a run when a write reaches a dead app, outside the floor
  and with no run in flight (`HeadlessRefreshPolicy.runForWrite`).
