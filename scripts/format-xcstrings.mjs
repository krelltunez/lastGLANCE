#!/usr/bin/env node
// Rewrite the iOS string catalogs in the exact shape Xcode saves them, so a
// build that syncs a catalog finds nothing to change and the committed file
// stays clean. Xcode writes .xcstrings with Foundation's JSONSerialization
// (pretty-printed, sorted keys): two-space indent, `"key" : value`, keys in
// case-insensitive numeric order, an empty object as `{` blank line `}`, and
// no newline at the end of the file.
//
// The catalog also has to hold every string the compiler extracts from the
// target's Swift (SWIFT_EMIT_LOC_STRINGS), or Xcode adds the missing keys on
// the next build. Brand words and bare numbers that are never translated stay
// in the catalog marked `"shouldTranslate" : false`.
//
// Usage: node scripts/format-xcstrings.mjs [--check]   (run from the repo root)

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CATALOGS = [
  'ios/App/App/Localizable.xcstrings',
  'ios/App/GlanceWidgets/Localizable.xcstrings',
  'ios/App/ShareExtension/Localizable.xcstrings',
]

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const byKey = (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)

const quote = (s) =>
  '"' +
  s.replace(/[\\"\u0000-\u001f/]/g, (c) => {
    if (c === '\\' || c === '"' || c === '/') return '\\' + c
    if (c === '\n') return '\\n'
    if (c === '\t') return '\\t'
    if (c === '\r') return '\\r'
    return '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
  }) +
  '"'

function write(value, depth) {
  const pad = '  '.repeat(depth + 1)
  const end = '  '.repeat(depth)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[\n\n' + end + ']'
    return '[\n' + value.map((v) => pad + write(v, depth + 1)).join(',\n') + '\n' + end + ']'
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort(byKey)
    if (keys.length === 0) return '{\n\n' + end + '}'
    return '{\n' + keys.map((k) => `${pad}${quote(k)} : ${write(value[k], depth + 1)}`).join(',\n') + '\n' + end + '}'
  }
  if (typeof value === 'string') return quote(value)
  return JSON.stringify(value)
}

export const formatCatalog = (text) => write(JSON.parse(text), 0)

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check')
  let stale = 0
  for (const rel of CATALOGS) {
    const path = resolve(root, rel)
    const text = readFileSync(path, 'utf8')
    const formatted = formatCatalog(text)
    if (text === formatted) continue
    stale++
    if (check) console.error(`${rel} is not in Xcode's format`)
    else { writeFileSync(path, formatted); console.log(`formatted ${rel}`) }
  }
  if (check && stale) process.exit(1)
}
