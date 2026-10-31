#!/bin/sh
# Refuse a Release build of the iOS app whose web view is Safari-inspectable.
#
# Run by the App target's "Refuse an inspectable Release build" build phase on
# every build; it acts only in the Release configuration, which is what
# Archive (TestFlight and App Store) uses. Debug builds pass straight through,
# so Xcode Run stays inspectable.
#
# capacitor.config.ts sets ios.webContentsDebuggingEnabled only when `cap sync`
# runs with CAP_WEBVIEW_DEBUG=1, and the synced ios/App/App/capacitor.config.json
# keeps that value until the next sync overwrites it. An archive made from that
# state would ship an inspectable WebView (localStorage holds sync credentials
# and passphrase material). Writing an explicit false instead is not an option:
# Capacitor reads the key before CAPACITOR_DEBUG, so false would also switch off
# inspection for Debug builds.
#
# Usage: ios-release-config-guard.sh <path to the synced capacitor.config.json>
# Reads CONFIGURATION from the environment (Xcode sets it).
set -eu

[ "${CONFIGURATION:-}" = "Release" ] || exit 0

config="${1:?usage: ios-release-config-guard.sh <capacitor.config.json>}"

# Fail closed: a Release build this check cannot read is not one it has cleared.
if [ ! -r "$config" ]; then
  echo "error: $config is missing or unreadable, so the Release build cannot be checked for an inspectable WebView. Run: npm run build:ios" >&2
  exit 1
fi
if ! plutil -convert json -o - "$config" >/dev/null 2>&1; then
  echo "error: $config is not valid JSON, so the Release build cannot be checked for an inspectable WebView. Run: npm run build:ios" >&2
  exit 1
fi

# An absent key is the normal state (Capacitor then falls back to
# CAPACITOR_DEBUG, which only debug.xcconfig sets); only an explicit true fails.
value=$(plutil -extract ios.webContentsDebuggingEnabled raw -o - "$config" 2>/dev/null || true)
if [ "$value" = "true" ]; then
  echo "error: this Release build would ship a Safari-inspectable WebView: $config was synced with CAP_WEBVIEW_DEBUG=1 (ios.webContentsDebuggingEnabled is true). Re-sync without it (npm run build:ios) and build again." >&2
  exit 1
fi
