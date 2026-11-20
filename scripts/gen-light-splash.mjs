#!/usr/bin/env node
// Write the LIGHT-appearance launch splash: the app icon, unmodified
// (public/brand/icon-primary.svg, its own rounded navy tile), centred on the
// light theme background (Tailwind slate-50, the body background in light
// mode). The brand has no light artwork, so the icon is used as it is rather
// than recoloured.
//
// The icon is sized so its dot grid lands exactly where the dark splash's grid
// does (692 px of the 2732 px canvas), so switching appearance moves nothing:
// inside the tile the light splash is pixel-identical to the dark one.
//
// Writes assets/splash.png, the @capacitor/assets source for the light splash
// (assets/splash-dark.png stays the dark one), and the three light iOS images
// in Splash.imageset, so the launch screen follows the system appearance
// without re-running the asset generator (which would also rewrite Android).
//
// Usage: node scripts/gen-light-splash.mjs   (run from the repo root)

import sharp from 'sharp'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export const LIGHT_BACKGROUND = '#F8FAFC'
const CANVAS = 2732
// The dark splash's dot grid spans 692 px; in the 512-unit icon it spans
// 39.84..472.16, 432.32 units.
const ICON = Math.round((512 * 692) / 432.32)

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(resolve(root, 'public/brand/icon-primary.svg'))
const icon = await sharp(svg, { density: (72 * ICON) / 512 }).resize(ICON, ICON).png().toBuffer()
const offset = Math.round((CANVAS - ICON) / 2)
const splash = await sharp({ create: { width: CANVAS, height: CANVAS, channels: 4, background: LIGHT_BACKGROUND } })
  .composite([{ input: icon, left: offset, top: offset }])
  .png()
  .toBuffer()

const outputs = [
  'assets/splash.png',
  ...[1, 2, 3].map((n) => `ios/App/App/Assets.xcassets/Splash.imageset/Default@${n}x~universal~anyany.png`),
]
for (const out of outputs) await sharp(splash).toFile(resolve(root, out))
console.log(`light splash: icon ${ICON}px on ${LIGHT_BACKGROUND} -> ${outputs.join(', ')}`)
