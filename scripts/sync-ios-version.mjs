#!/usr/bin/env node
// Sync the iOS app's marketing version (CFBundleShortVersionString) with the
// version in package.json — the iOS analogue of the package.json-derived
// versionName in android/app/build.gradle.
//
// Marketing version only. The build number (CURRENT_PROJECT_VERSION /
// CFBundleVersion) must increment per TestFlight/App Store upload and is left
// for the upload step to manage.
//
// Usage: node scripts/sync-ios-version.mjs   (run from the repo root)

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
const pbxPath = resolve(root, 'ios/App/App.xcodeproj/project.pbxproj')

const pbx = readFileSync(pbxPath, 'utf8')
const updated = pbx.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`)

if (updated === pbx) {
  console.log(`iOS MARKETING_VERSION already ${version} (no change)`)
} else {
  writeFileSync(pbxPath, updated)
  console.log(`iOS MARKETING_VERSION -> ${version}`)
}
