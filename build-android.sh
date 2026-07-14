#!/bin/bash
set -e

# lastGLANCE Android build — ported from the dayGLANCE build script.
# Differences: the Capacitor project dir is android/ (not renamed), and this
# builds a single APK (no play/github flavors).
#
# Usage:
#   ./build-android.sh                     debug APK + install on a connected device
#   ./build-android.sh --release           signed release APK + .aab for the Play Store
#                                          -> outputs/lastglance.apk, outputs/lastglance.aab
#   ./build-android.sh --release --build N  release build with a test versionCode
#                                          (N = 1..99) for internal/closed-test uploads
#   ./build-android.sh --clean             full gradle clean + wipe dist/ first
# Flags combine, e.g. ./build-android.sh --clean --release --build 2
#
# versionName always comes from package.json (e.g. 1.12.0). The versionCode
# normally derives from it (android/app/build.gradle). Play requires each upload
# to have a strictly higher versionCode than any previous upload, so for a
# pre-release/internal build use --build N: it computes base + N (e.g. 1.12.0
# build 2 -> 1120002), so you can't fat-finger a raw code. Keep incrementing N
# per upload, then PROMOTE the bundle that passes to production (don't rebuild a
# lower code for it).
#
# Escape hatch: APP_VERSION_CODE=<raw code> ./build-android.sh --release still
# works if you ever need to set the code by hand. --build wins if both are given.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$SCRIPT_DIR/android"
OUT_DIR="$SCRIPT_DIR/outputs"

# Flags
FULL_CLEAN=false
RELEASE=false
BUILD_NUM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --clean)   FULL_CLEAN=true; shift ;;
    --release) RELEASE=true; shift ;;
    --build)
      if [ $# -lt 2 ]; then echo "Error: --build needs a number, e.g. --build 3" >&2; exit 1; fi
      BUILD_NUM="$2"; shift 2 ;;
    --build=*) BUILD_NUM="${1#--build=}"; shift ;;
    *) echo "Unknown flag: $1 (valid flags: --clean, --release, --build N)" >&2; exit 1 ;;
  esac
done

# --build N derives a pre-release versionCode (base + N) from package.json, so an
# internal/closed-test upload gets a strictly higher code than the last without
# hand-typing (and mistyping) a raw value. Sets APP_VERSION_CODE, which the
# release build below passes through to Gradle.
if [ -n "$BUILD_NUM" ]; then
  if ! $RELEASE; then
    echo "Error: --build N applies to release builds; add --release." >&2
    exit 1
  fi
  if ! printf '%s' "$BUILD_NUM" | grep -Eq '^[0-9]+$' || [ "$BUILD_NUM" -lt 1 ] || [ "$BUILD_NUM" -gt 99 ]; then
    echo "Error: --build N must be a whole number from 1 to 99." >&2
    echo "       (Need more than 99 test builds? Bump the patch version: npm version patch.)" >&2
    exit 1
  fi
  # Base versionCode must match android/app/build.gradle:
  #   major*1000000 + minor*10000 + patch*100
  VERSION="$(node -e 'console.log(require(process.argv[1]).version)' "$SCRIPT_DIR/package.json")"
  IFS='.' read -r VMAJ VMIN VPAT <<< "$VERSION"
  APP_VERSION_CODE=$(( VMAJ * 1000000 + VMIN * 10000 + VPAT * 100 + BUILD_NUM ))
  export APP_VERSION_CODE
  echo "==> Test build #$BUILD_NUM -> versionName $VERSION, versionCode $APP_VERSION_CODE"
fi

# ── Clean ──────────────────────────────────────────────────────────────────
if $FULL_CLEAN; then
  echo "==> Full clean..."
  cd "$ANDROID_DIR" && ./gradlew clean
  cd "$SCRIPT_DIR"
  rm -rf dist
else
  # Vite produces a new content-hashed bundle on every build, so Gradle's
  # incremental asset pipeline accumulates stale .jar files for the old
  # hashes and then fails with "already contains entry". Wipe just that
  # intermediates directory — it is cheap and rebuilt every assemble.
  STALE_ASSETS="$ANDROID_DIR/app/build/intermediates/compressed_assets"
  if [ -d "$STALE_ASSETS" ]; then
    echo "==> Clearing stale asset intermediates..."
    rm -rf "$STALE_ASSETS"
  fi
fi

mkdir -p "$OUT_DIR"

# ── Dependencies ────────────────────────────────────────────────────────────
# Auto-install JS deps when node_modules is missing or older than the lockfile
# (e.g. after a git pull that changed package-lock.json), so a forgotten
# `npm install` can't silently break the build. No-op on an up-to-date tree.
cd "$SCRIPT_DIR"
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules ]; then
  echo "==> Installing JS dependencies (node_modules missing or lockfile changed)..."
  npm install
fi

if $RELEASE; then
  # ── Release APK ────────────────────────────────────────────────────────
  if [ ! -f "$ANDROID_DIR/keystore.properties" ]; then
    echo "WARNING: android/keystore.properties not found — the release APK will"
    echo "         be UNSIGNED and not installable. See keystore.properties.example."
  fi

  # Channel-split release builds (docs/paywall-billing-plan.md): the sideload
  # APK is UNGATED (github channel) and the Play AAB is GATED (play channel),
  # so each artifact needs its own web build — VITE_BUILD_CHANNEL is baked in
  # at Vite build time. APP_VERSION_CODE, when set, overrides the derived
  # versionCode for both artifacts (see build.gradle).

  echo "==> Building web assets (channel: github — ungated sideload APK)..."
  cd "$SCRIPT_DIR"
  VITE_BUILD_CHANNEL=github npm run build:android
  cd "$ANDROID_DIR"
  ./gradlew assembleRelease ${APP_VERSION_CODE:+-PappVersionCode="$APP_VERSION_CODE"}
  cp "app/build/outputs/apk/release/lastglance.apk" "$OUT_DIR/lastglance.apk"
  echo "    APK (release, github channel) → outputs/lastglance.apk"

  # The reviewer bypass (@glance-apps/billing rule 9: store review needs a way
  # past a hard gate) is compiled in from src/config/reviewerAccess.js — a
  # committed secret, no env var to set. Run `npm run reviewer-code` to print
  # the current month's code for the store review notes.
  echo "==> Building web assets (channel: play — gated AAB)..."
  cd "$SCRIPT_DIR"
  VITE_BUILD_CHANNEL=play npm run build:android
  cd "$ANDROID_DIR"
  ./gradlew bundleRelease ${APP_VERSION_CODE:+-PappVersionCode="$APP_VERSION_CODE"}

  # The bundle task ignores the APK outputFileName rename in build.gradle, so
  # the .aab keeps its default name (app-release.aab); copy it to a stable path.
  cp "app/build/outputs/bundle/release/app-release.aab" "$OUT_DIR/lastglance.aab"
  echo "    AAB (release, play channel) → outputs/lastglance.aab"

  # Verify the APK carries a valid signature (catches a misconfigured or
  # missing keystore.properties that would otherwise ship an unsigned APK/AAB).
  SDK_DIR="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
  APKSIGNER="$(command -v apksigner || true)"
  if [ -z "$APKSIGNER" ] && [ -n "$SDK_DIR" ]; then
    APKSIGNER="$(ls "$SDK_DIR"/build-tools/*/apksigner 2>/dev/null | sort -V | tail -1)"
  fi
  if [ -n "$APKSIGNER" ]; then
    echo "==> Verifying signature..."
    "$APKSIGNER" verify --print-certs "$OUT_DIR/lastglance.apk"
  else
    echo "    (apksigner not found on PATH or in \$ANDROID_HOME; skipping signature check)"
  fi

  echo ""
  echo "==> Android release build complete. outputs/:"
  ls -lh "$OUT_DIR"

else
  # ── Debug APK + install ────────────────────────────────────────────────
  echo "==> Building web assets..."
  cd "$SCRIPT_DIR"
  npm run build:android

  APK_SRC="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
  APK_DEST="$OUT_DIR/lastglance-debug.apk"

  echo "==> Building debug APK..."
  cd "$ANDROID_DIR"
  ./gradlew assembleDebug

  cp "$APK_SRC" "$APK_DEST"
  echo "    APK (debug) → outputs/lastglance-debug.apk"

  # Install only if a device is actually connected, so the build still
  # succeeds on a machine with no device/emulator attached.
  if command -v adb >/dev/null 2>&1 && [ -n "$(adb devices | sed -n '2p')" ]; then
    echo "==> Installing on connected device..."
    adb install -r "$APK_DEST"
    echo "==> Done! App installed."
  else
    echo "==> No device/adb detected; skipping install. APK at $APK_DEST"
  fi
fi
