#!/usr/bin/env node
// Checks a BUILT app for what the Mac App Store build must not carry
// (docs/mcp-and-stream-deck.md, section 7; after dayGLANCE's script of the same
// name): the Claude Desktop setup, which installs and runs code the app does
// not ship through the store (App Review Guideline 2.5.2). Source checks
// cannot see a packaging mistake; this reads the archive that would ship.
//
//   node scripts/verify-mas-compileout.mjs --mas    <app or resources dir>
//   node scripts/verify-mas-compileout.mjs --direct <app or resources dir>
//
// --mas: the setup modules are not in app.asar, no renderer bundle holds the
// button's code, and the bridge is not in Resources. --direct: all three are
// there (so the check cannot pass by looking in the wrong place), except the
// bridge on Linux, which never carries it. The path is a .app, or the folder
// holding app.asar (dist-app/linux-unpacked/resources, win-unpacked/resources).
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import asar from '@electron/asar'

const [mode, target] = process.argv.slice(2)
if ((mode !== '--mas' && mode !== '--direct') || !target) {
  console.error('usage: node scripts/verify-mas-compileout.mjs --mas|--direct <app or resources dir>')
  process.exit(2)
}
const resources = target.endsWith('.app') ? path.join(target, 'Contents', 'Resources') : target
const archive = path.join(resources, 'app.asar')
if (!existsSync(archive)) {
  console.error(`no app.asar under ${resources}`)
  process.exit(2)
}

const failures = []
const check = (ok, what) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`)
  if (!ok) failures.push(what)
}

const entries = new Set(asar.listPackage(archive, { isPack: false }).map((e) => e.replace(/\\/g, '/')))
const mas = mode === '--mas'
for (const module of ['/dist-electron/mcpDesktopSetup.js', '/dist-electron/mcpDesktopConfig.js']) {
  check(entries.has(module) === !mas, `${module} ${mas ? 'is not' : 'is'} in app.asar`)
}

// The button's code, as the renderer bundle carries it: its translation key.
// __MAS_BUILD__ makes the branch dead code, so the minifier drops the key with
// it. While the whole panel is unmounted (LOCAL_INTEGRATIONS_UI, until it
// ships) neither build carries it, and the check says so rather than passing
// for the wrong reason.
const PANEL_KEY = 'localIntegrations.mcpHint'
const BUTTON_KEY = 'localIntegrations.claudeDesktopSetup'
const bundles = [...entries].filter((e) => /^\/dist\/assets\/.*\.js$/.test(e))
check(bundles.length > 0, `renderer bundles found (${bundles.length})`)
const texts = bundles.map((e) => [e, asar.extractFile(archive, e.slice(1)).toString('utf-8')])
if (!texts.some(([, t]) => t.includes(PANEL_KEY))) {
  console.log('--   the local integrations panel is not in this build yet (LOCAL_INTEGRATIONS_UI), so there is no button to check')
} else {
  const carrying = texts.filter(([, t]) => t.includes(BUTTON_KEY)).map(([e]) => e)
  check(mas ? carrying.length === 0 : carrying.length > 0, `the Set up Claude Desktop button ${mas ? 'is not' : 'is'} in the renderer bundle${carrying.length ? ` (${carrying.join(', ')})` : ''}`)
}

// The bridge the setup points Claude at: Resources/mcp-bridge/bridge.js on
// direct macOS and Windows builds, nowhere on MAS or Linux.
const bridge = path.join(resources, 'mcp-bridge', 'bridge.js')
const linux = /linux-unpacked/.test(resources)
const shouldCarry = !mas && !linux
check(existsSync(bridge) === shouldCarry, `the MCP bridge ${shouldCarry ? 'is' : 'is not'} in Resources${linux ? ' (Linux never carries it)' : ''}`)

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log(`\n${mas ? 'Mac App Store' : 'direct'} build carries what it should`)
