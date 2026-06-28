#!/usr/bin/env node
// Build a signed Android App Bundle (AAB) with the correct versionCode, derived
// from package.json so you can't fat-finger the digits.
//
//   node scripts/android-release.mjs              # release build  (versionCode = base)
//   node scripts/android-release.mjs --build 3    # test build #3  (versionCode = base + 3)
//   node scripts/android-release.mjs --build 3 --dry-run   # just print the numbers
//
// versionName is always package.json's version (e.g. 1.12.0). The base
// versionCode is major*1000000 + minor*10000 + patch*100 (matching
// android/app/build.gradle), e.g. 1.12.0 -> 1120000. `--build N` (1..99) adds N
// for internal/closed test uploads, which each need a strictly higher code than
// the last. Keep incrementing N for every test upload, then PROMOTE the build
// that passes to production (don't rebuild a lower code for it). For a real
// version change, bump package.json first (npm version <major|minor|patch>).

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// --- args ---
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
let build = 0
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (a === '--build' || a === '-b') build = Number(argv[++i])
  else if (a.startsWith('--build=')) build = Number(a.slice('--build='.length))
}
if (build !== 0 && (!Number.isInteger(build) || build < 1 || build > 99)) {
  console.error('Error: --build N must be a whole number from 1 to 99.')
  console.error('  (That is the per-patch test band. Need more than 99? Bump the patch')
  console.error('   version with `npm version patch` and start over at --build 1.)')
  process.exit(1)
}

// --- version math (keep in sync with android/app/build.gradle) ---
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
const parts = version.split('.').map(Number)
if (parts.length !== 3 || parts.some(n => !Number.isInteger(n))) {
  console.error(`Error: package.json version is not major.minor.patch: "${version}"`)
  process.exit(1)
}
const [major, minor, patch] = parts
const base = major * 1_000_000 + minor * 10_000 + patch * 100
const versionCode = base + build

const label = build ? `test build #${build}` : 'release build'
console.log(`\nlastGLANCE Android ${label}`)
console.log(`  versionName  ${version}`)
console.log(`  versionCode  ${versionCode}${build ? `  (${base} + ${build})` : ''}`)
console.log('')

if (dryRun) process.exit(0)

// --- build ---
function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts })
}

run('npm', ['run', 'build'])                       // web app
run('npx', ['cap', 'sync', 'android'])             // copy into native project
const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew'
run(gradlew, ['bundleRelease', `-PappVersionCode=${versionCode}`], { cwd: resolve(root, 'android') })

console.log('\nDone.')
console.log('  AAB: android/app/build/outputs/bundle/release/app-release.aab')
console.log(`  Upload as versionName ${version}, versionCode ${versionCode}.`)
if (build) console.log('  Tip: promote this exact bundle to production once it passes; do not rebuild a lower code.')
