#!/usr/bin/env bash
# Download the iOS app's Swift binary targets into a SwiftPM cache, so that
# `xcodebuild -packageCachePath <cache>` copies them from there instead of
# downloading them itself. Used by .github/workflows/ios.yml.
#
# Why: the Xcode on GitHub's macOS runners ships a SwiftPM that, when a binary
# download gets an HTTP error, saves the error body at the cache path as if it
# were the artifact. Its retry then fails with "<path> already exists in file
# system", which hides the real status code. SwiftPM fixed this upstream on
# 2026-01-08 (swiftlang/swift-package-manager#9474). On 2026-11-09 GitHub's
# release downloads intermittently answered with server errors, and the iOS
# build failed that way before compiling. curl retries those errors and
# reports the real status.
#
# SwiftPM still verifies each artifact against the checksum in its manifest
# when it copies it from the cache, so a file seeded here is checked exactly
# like one SwiftPM downloaded. If SwiftPM's cache layout ever changes, it
# simply misses these files and downloads as before.
#
# The URLs come from the manifests, so a version bump needs no edit here:
#   - Capacitor and Cordova, from capacitor-swift-pm at the exact version in
#     ios/App/CapApp-SPM/Package.swift (Capacitor CLI writes that file);
#   - every remote binaryTarget in ios/App/Packages/*/Package.swift (RevenueCat).
#
# Usage: scripts/ios-prefetch-binary-artifacts.sh <cache dir>
set -euo pipefail

cache="${1:?usage: $0 <cache dir>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
artifacts="$cache/artifacts"
mkdir -p "$artifacts"

urls=()
capacitor=$(sed -n 's/.*capacitor-swift-pm\.git", exact: "\([^"]*\)".*/\1/p' "$root/ios/App/CapApp-SPM/Package.swift")
if [ -z "$capacitor" ]; then
  echo "::error::No exact capacitor-swift-pm version in ios/App/CapApp-SPM/Package.swift" >&2
  exit 1
fi
for target in Capacitor Cordova; do
  urls+=("https://github.com/ionic-team/capacitor-swift-pm/releases/download/$capacitor/$target.xcframework.zip")
done
for manifest in "$root"/ios/App/Packages/*/Package.swift; do
  while IFS= read -r url; do urls+=("$url"); done \
    < <(sed -n 's/.*url: "\(https:[^"]*\.zip\)".*/\1/p' "$manifest")
done

for url in "${urls[@]}"; do
  # SwiftPM's cache key: the URL with every character outside [A-Za-z0-9_]
  # replaced by "_" (spm_mangledToC99ExtendedIdentifier).
  key=$(printf '%s' "$url" | sed 's/[^A-Za-z0-9_]/_/g')
  dest="$artifacts/$key"
  if [ -s "$dest" ]; then
    echo "cached  $url"
    continue
  fi
  echo "fetch   $url"
  # --fail: an HTTP error is a failure, never a file. Written to .part and
  # renamed only on success, so an error body never lands at the cache path.
  curl --fail --location --silent --show-error \
    --retry 6 --retry-all-errors --retry-delay 10 \
    --connect-timeout 30 --max-time 900 \
    --write-out '        %{http_code}, %{size_download} bytes in %{time_total}s\n' \
    --output "$dest.part" "$url"
  mv "$dest.part" "$dest"
done
