#!/bin/bash
set -e

# lastGLANCE Android build — ported from the dayGLANCE build script.
# Differences: the Capacitor project dir is android/ (not renamed), and this
# builds a single APK (no play/github flavors, no AAB yet).
#
# Usage:
#   ./build-android.sh            debug APK + install on a connected device
#   ./build-android.sh --release  signed release APK -> outputs/lastglance.apk
#   ./build-android.sh --clean    full gradle clean + wipe dist/ first
# Flags combine, e.g. ./build-android.sh --clean --release

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$SCRIPT_DIR/android"
OUT_DIR="$SCRIPT_DIR/outputs"

# Flags
FULL_CLEAN=false
RELEASE=false
for arg in "$@"; do
  case "$arg" in
    --clean)   FULL_CLEAN=true ;;
    --release) RELEASE=true ;;
    *) echo "Unknown flag: $arg (valid flags: --clean, --release)" && exit 1 ;;
  esac
done

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

if $RELEASE; then
  # ── Release APK ────────────────────────────────────────────────────────
  if [ ! -f "$ANDROID_DIR/keystore.properties" ]; then
    echo "WARNING: android/keystore.properties not found — the release APK will"
    echo "         be UNSIGNED and not installable. See keystore.properties.example."
  fi

  echo "==> Building web assets..."
  cd "$SCRIPT_DIR"
  npm run build:android

  echo "==> Building release APK..."
  cd "$ANDROID_DIR"
  ./gradlew assembleRelease

  cp "app/build/outputs/apk/release/lastglance.apk" "$OUT_DIR/lastglance.apk"
  echo "    APK (release) → outputs/lastglance.apk"

  # Verify the APK carries a valid signature (catches a misconfigured or
  # missing keystore.properties that would otherwise ship an unsigned APK).
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
