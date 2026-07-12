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
