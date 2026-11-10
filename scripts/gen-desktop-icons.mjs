#!/usr/bin/env node
// Desktop app icons (docs/desktop-app.md, section 11), rendered from the brand
// SVGs in public/brand/ into electron/resources/:
//
//   icon-mac.png  1024px, Apple's macOS grid: the full-bleed artwork
//                 (icon-primary-square.svg) clipped to an 824px rounded square,
//                 centered on a transparent canvas with a soft shadow. A
//                 full-bleed square, as iOS uses, reads oversized and unrounded
//                 in the Dock next to every other Mac app.
//   icon.png      1024px, icon-primary.svg as is (its own ~18% rounding), for
//                 Windows and Linux, where electron-builder derives the .ico
//                 and the hicolor PNG set from it.
//   tray/         the tray icon (section 7), the brand mark reduced to a 5x5
//                 grid with its highlighted bar: trayTemplate.png and @2x for
//                 the macOS menu bar (black and alpha only; macOS tints it),
//                 tray.png and @2x in the brand colors for Windows and Linux.
//                 Shipped as extraResources.
//
// Run after a brand change and commit the output:
//
//   node scripts/gen-desktop-icons.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const brand = (name) => fs.readFileSync(path.join(root, 'public/brand', name), 'utf-8')
const outDir = path.join(root, 'electron/resources')
fs.mkdirSync(outDir, { recursive: true })

const CANVAS = 1024
const BODY = 824 // Apple's icon grid: 824px body on a 1024px canvas.
const OFFSET = (CANVAS - BODY) / 2
const RADIUS = 185.4 // The grid's corner radius for an 824px body.

// The square artwork, as an embeddable <svg> scaled to the body size.
const artwork = brand('icon-primary-square.svg')
  .replace(/<\?xml[^>]*>/, '')
  .replace(/<svg([^>]*?)\swidth="512"\sheight="512"/, `<svg$1 x="${OFFSET}" y="${OFFSET}" width="${BODY}" height="${BODY}"`)

const macSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
  <defs>
    <clipPath id="body"><rect x="${OFFSET}" y="${OFFSET}" width="${BODY}" height="${BODY}" rx="${RADIUS}"/></clipPath>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="130%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.3"/>
    </filter>
  </defs>
  <rect x="${OFFSET}" y="${OFFSET}" width="${BODY}" height="${BODY}" rx="${RADIUS}" fill="#05081A" filter="url(#shadow)"/>
  <g clip-path="url(#body)">${artwork}</g>
</svg>`

await sharp(Buffer.from(macSvg)).png().toFile(path.join(outDir, 'icon-mac.png'))
await sharp(Buffer.from(brand('icon-primary.svg')), { density: 72 * (CANVAS / 512) })
  .resize(CANVAS, CANVAS)
  .png()
  .toFile(path.join(outDir, 'icon.png'))

// The tray mark: a 5x5 grid of rounded cells with the middle column's
// middle three lit, as the brand mark's bar. `scale` is 1 or 2.
function traySvg(scale, lit, dim) {
  const cell = 2 * scale, gap = 1 * scale, size = 16 * scale, offset = 1 * scale
  let cells = ''
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 5; c++) {
      const on = c === 2 && r >= 1 && r <= 3
      cells += `<rect x="${offset + c * (cell + gap)}" y="${offset + r * (cell + gap)}" width="${cell}" height="${cell}" rx="${0.5 * scale}" fill="${on ? lit : dim}"/>`
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${cells}</svg>`
}
const trayDir = path.join(outDir, 'tray')
fs.mkdirSync(trayDir, { recursive: true })
for (const [scale, suffix] of [[1, ''], [2, '@2x']]) {
  await sharp(Buffer.from(traySvg(scale, '#000000', 'rgba(0,0,0,0.38)'))).png().toFile(path.join(trayDir, `trayTemplate${suffix}.png`))
  await sharp(Buffer.from(traySvg(scale, '#3DDC84', 'rgba(148,163,184,0.75)'))).png().toFile(path.join(trayDir, `tray${suffix}.png`))
}

console.log('wrote electron/resources/icon-mac.png, icon.png and tray/')
