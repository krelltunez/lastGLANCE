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

console.log('wrote electron/resources/icon-mac.png and icon.png')
