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
