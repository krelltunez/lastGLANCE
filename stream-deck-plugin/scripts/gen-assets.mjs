// Generates what the plugin needs and git does not keep (stream-deck-plugin/.gitignore):
//  - src/generated/icons.json: every Lucide icon by the names the app stores,
//    from lucide-react, the package the app draws with, grouped and named by
//    the widgets' own rules (../../scripts/lucide-names.mjs), so a key draws
//    the icon the app shows;
//  - the plugin's images (com.lastglance.streamdeck.sdPlugin/imgs): the app
//    icon, the lastGLANCE mark as the category icon, and a glyph and a default
//    key image per action.
//
// Run from stream-deck-plugin/ (npm run icons, part of npm run build). It reads
// the app's own node_modules (lucide-react, react-dom, sharp), so the root
// package must be installed first.
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import sharp from 'sharp'
import * as Lucide from 'lucide-react'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalName, iconGroups } from '../../scripts/lucide-names.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = join(here, '..')
const app = join(plugin, '..')
const imgs = join(plugin, 'com.lastglance.streamdeck.sdPlugin', 'imgs')

// ── The icon table ──────────────────────────────────────────────────────────
const inner = (component) => renderToStaticMarkup(createElement(component)).replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '')
const icons = {}
const aliases = {}
for (const [component, names] of iconGroups()) {
  const canonical = canonicalName(names)
  icons[canonical] = inner(component)
  for (const n of names) if (n !== canonical) aliases[n] = canonical
}
mkdirSync(join(plugin, 'src', 'generated'), { recursive: true })
writeFileSync(join(plugin, 'src', 'generated', 'icons.json'), JSON.stringify({ icons, aliases }))
console.log(`icons: ${Object.keys(icons).length} icons, ${Object.keys(aliases).length} aliases`)

// ── Images ──────────────────────────────────────────────────────────────────
const svgIcon = (name, size, color) => {
  const component = Lucide[name]
  if (!component) throw new Error(`no Lucide icon ${name}`)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner(component)}</svg>`
}

// The lastGLANCE mark (electron/resources' tray drawing): a rounded square
// holding a 3x3 grid, its middle column lit.
const mark = (size, color) => {
  const cell = 2.95, gap = 1.15, grid = 3 * cell + 2 * gap, o = (22 - grid) / 2
  let cells = ''
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
    cells += `<rect x="${o + c * (cell + gap)}" y="${o + r * (cell + gap)}" width="${cell}" height="${cell}" rx="0.7" fill="${color}" fill-opacity="${c === 1 ? 1 : 0.45}"/>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 22 22"><rect x="1.85" y="1.85" width="18.3" height="18.3" rx="4.6" fill="none" stroke="${color}" stroke-width="1.7"/>${cells}</svg>`
}

const keyImage = (name, accent) => `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="#14161c"/><g transform="translate(36 36) scale(3)" fill="none" stroke="${accent}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner(Lucide[name])}</g></svg>`

const write = (rel, data) => { const p = join(imgs, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data) }

// The plugin's own icon: the app's icon, at Stream Deck's two sizes.
mkdirSync(join(imgs, 'plugin'), { recursive: true })
await sharp(join(app, 'electron', 'resources', 'icon.png')).resize(256, 256).png().toFile(join(imgs, 'plugin', 'icon.png'))
await sharp(join(app, 'electron', 'resources', 'icon.png')).resize(512, 512).png().toFile(join(imgs, 'plugin', 'icon@2x.png'))
write('plugin/category.svg', mark(28, '#ffffff'))

// Each action: a white glyph for Stream Deck's action list, and a default key.
export const ACTION_ICONS = {
  chore: ['CircleCheck', '#22c55e'],
  due: ['ListTodo', '#ef4444'],
  pinned: ['Pin', '#f59e0b'],
  // The Soon key (its folder keeps the id it first had, overview).
  overview: ['AlarmClock', '#f59e0b'],
  'reach-out': ['MessageCircleHeart', '#ef4444'],
  // keys.ts ROSE: the app's pink, toned down for a lit key.
  'coming-up': ['Cake', '#c27a9c'],
  'add-chore': ['Plus', '#38bdf8'],
}
for (const [action, [name, accent]] of Object.entries(ACTION_ICONS)) {
  write(`actions/${action}/icon.svg`, svgIcon(name, 20, '#ffffff'))
  write(`actions/${action}/key.svg`, keyImage(name, accent))
}
console.log(`images: ${imgs}`)
