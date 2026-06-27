// Generate Android vector drawables for the full Lucide icon set, so the native
// home-screen widgets can show a chore's icon. Source of truth is lucide-react
// (the exact package the in-app icon registry uses), so the names match the
// values stored in chore.icon with no kebab-case guessing.
//
// Each drawable is named ic_lucide_<snake(PascalName)> using the SAME transform
// the widget applies at runtime (see lucideResName below + SingleChoreWidget.kt).
// Stroke color is forced opaque so the widget can tint it to the recency color.
//
// Run: node scripts/gen-lucide-drawables.mjs
// Output: android/app/src/main/res/drawable/ic_lucide_*.xml

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import * as Lucide from 'lucide-react'
import svg2vectordrawable from 'svg2vectordrawable'
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../android/app/src/main/res/drawable',
)

// Snake-case a PascalCase name, char by char (no regex), so the JS generator and
// the Kotlin runtime derive identical resource names.
function lucideResName(pascal) {
  let out = ''
  for (let i = 0; i < pascal.length; i++) {
    const ch = pascal[i]
    const upper = ch >= 'A' && ch <= 'Z'
    if (upper && i > 0) out += '_'
    out += ch.toLowerCase()
  }
  return 'ic_lucide_' + out
}

// Mirror src/icons/registry.ts: keep real icon components, dedup by reference.
function iconEntries() {
  const seen = new Set()
  return Object.entries(Lucide).filter(([name, val]) => {
    if (
      name.endsWith('Icon') ||
      name === 'createLucideIcon' ||
      val === null ||
      typeof val !== 'object' ||
      !('$$typeof' in val)
    ) return false
    if (seen.has(val)) return false
    seen.add(val)
    return true
  })
}

// Lucide carries stroke styling on the <svg> root (stroke, width 2, round caps,
// fill none), which the converter doesn't propagate to the per-path output — so
// the paths come out with no stroke and render invisible. Every Lucide glyph
// uses the same styling, so inject it onto each <path>. Opaque black so the
// widget's runtime tint (to the chore's recency color) has something to recolor.
function applyLucideStroke(vectorXml) {
  return vectorXml
    .replace(/currentColor/g, '#FF000000')
    .replace(
      /<path\b/g,
      '<path android:strokeColor="#FF000000" android:strokeWidth="2"' +
        ' android:strokeLineCap="round" android:strokeLineJoin="round"',
    )
}

async function main() {
  const limit = process.argv[2] ? Number(process.argv[2]) : Infinity
  await mkdir(OUT_DIR, { recursive: true })

  // Clean previous generation so removed icons don't linger.
  for (const f of await readdir(OUT_DIR)) {
    if (f.startsWith('ic_lucide_') && f.endsWith('.xml')) {
      await rm(join(OUT_DIR, f))
    }
  }

  const entries = iconEntries().slice(0, limit)
  let ok = 0
  let fail = 0
  for (const [name, Icon] of entries) {
    try {
      const svg = renderToStaticMarkup(
        createElement(Icon, { color: '#000000', size: 24, strokeWidth: 2 }),
      )
      let xml = await svg2vectordrawable(svg, { floatPrecision: 2 })
      xml = applyLucideStroke(xml)
      await writeFile(join(OUT_DIR, `${lucideResName(name)}.xml`), xml)
      ok++
    } catch (e) {
      fail++
      console.error(`FAIL ${name}: ${e.message}`)
    }
  }
  console.log(`Generated ${ok} drawables (${fail} failed) into ${OUT_DIR}`)
}

main()
