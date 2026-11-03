// Generate Swift path data for the full Lucide icon set, so the iOS widgets can
// show a chore's icon. The iOS sibling of gen-lucide-drawables.mjs: same source
// of truth (lucide-react, the exact package the in-app icon registry uses), so
// the names match the values stored in chore.icon with no case guessing.
//
// Unlike Android (one vector-drawable XML per icon), iOS gets ONE generated
// Swift file containing every icon's SVG path data as a single multiline string
// literal, parsed lazily at runtime by LucidePath.swift. A string literal is
// deliberate: a 1,700-entry dictionary literal is exactly the shape Swift's
// type checker is slowest at, while a single string costs the compiler nothing.
//
// lucide exports each icon under several names, and chore.icon can hold any of
// them (ICON_REGISTRY resolves them all). Each icon's path data is written once,
// under the name canonicalName picks, and every other name gets a line in a
// second string mapping it to that one.
//
// Every non-<path> SVG element (circle, rect, line, polyline, polygon, ellipse)
// is converted to equivalent path data here, so the Swift side only ever needs
// an SVG *path* parser, not an SVG parser. Any element or attribute this script
// does not understand (e.g. a transform) is a hard error, not a skip — a
// silently missing icon would be invisible until a user picks it.
//
// Before writing, every generated path is run through a JS interpreter that
// mirrors LucidePath.swift command for command (including the endpoint-to-
// center arc conversion). Structural errors (wrong arity, bad flags) and wild
// geometry (bounding box outside the 24x24 viewBox + tolerance) fail the build
// here, on Linux, instead of rendering garbage on a device.
//
// Run: node scripts/gen-lucide-swift.mjs  (or: npm run gen:icons:ios)
// Output: ios/App/GlanceWidgets/LucideIcons.generated.swift

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { canonicalName, iconGroups } from './lucide-names.mjs'

const OUT_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  '../ios/App/GlanceWidgets/LucideIcons.generated.swift',
)

// ── SVG element → path data ─────────────────────────────────────────────────

const DRAWN = new Set(['path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon'])
// Attributes that would change geometry if ignored. Anything else (stroke
// styling, class, aria) is inherited from the root and safe to drop.
const FORBIDDEN_ATTRS = new Set(['transform', 'clip-path', 'mask', 'marker-start', 'marker-mid', 'marker-end'])

function parseAttrs(raw) {
  const attrs = {}
  for (const m of raw.matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g)) attrs[m[1]] = m[2]
  return attrs
}

function num(attrs, key, fallback = 0) {
  const v = attrs[key]
  if (v === undefined) return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error(`non-numeric ${key}="${v}"`)
  return n
}

function elementToPath(tag, attrs) {
  for (const key of Object.keys(attrs)) {
    if (FORBIDDEN_ATTRS.has(key)) throw new Error(`unsupported attribute ${key} on <${tag}>`)
  }
  switch (tag) {
    case 'path': {
      if (!attrs.d) throw new Error('<path> without d')
      return attrs.d
    }
    case 'circle': {
      const cx = num(attrs, 'cx'), cy = num(attrs, 'cy'), r = num(attrs, 'r')
      return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`
    }
    case 'ellipse': {
      const cx = num(attrs, 'cx'), cy = num(attrs, 'cy')
      const rx = num(attrs, 'rx'), ry = num(attrs, 'ry')
      return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0z`
    }
    case 'rect': {
      const x = num(attrs, 'x'), y = num(attrs, 'y')
      const w = num(attrs, 'width'), h = num(attrs, 'height')
      let rx = num(attrs, 'rx'), ry = num(attrs, 'ry', rx || 0)
      if (rx === 0 && ry === 0) return `M${x} ${y}h${w}v${h}h${-w}z`
      rx = Math.min(rx || ry, w / 2)
      ry = Math.min(ry || rx, h / 2)
      return (
        `M${x + rx} ${y}h${w - 2 * rx}a${rx} ${ry} 0 0 1 ${rx} ${ry}` +
        `v${h - 2 * ry}a${rx} ${ry} 0 0 1 ${-rx} ${ry}` +
        `h${-(w - 2 * rx)}a${rx} ${ry} 0 0 1 ${-rx} ${-ry}` +
        `v${-(h - 2 * ry)}a${rx} ${ry} 0 0 1 ${rx} ${-ry}z`
      )
    }
    case 'line': {
      return `M${num(attrs, 'x1')} ${num(attrs, 'y1')}L${num(attrs, 'x2')} ${num(attrs, 'y2')}`
    }
    case 'polyline':
    case 'polygon': {
      const pts = (attrs.points ?? '').trim().split(/[\s,]+/).map(Number)
      if (pts.length < 4 || pts.length % 2 !== 0 || pts.some(n => !Number.isFinite(n)))
        throw new Error(`bad points="${attrs.points}"`)
      let d = `M${pts[0]} ${pts[1]}`
      for (let i = 2; i < pts.length; i += 2) d += `L${pts[i]} ${pts[i + 1]}`
      return tag === 'polygon' ? d + 'z' : d
    }
    default:
      throw new Error(`unsupported element <${tag}>`)
  }
}

// Rewrite a path's leading relative moveto to an absolute one. At the start of
// a standalone path the spec treats `m x y` as absolute, so this is a no-op
// semantically — but once paths are CONCATENATED, a leading `m` would continue
// from the previous path's endpoint and silently shift the whole subpath. Only
// the first coordinate pair may be rewritten: pairs after a moveto are implicit
// linetos in the moveto's relativity, so `m 19 12 -7 7` must become
// `M 19 12 l -7 7`, not `M 19 12 -7 7` (which would make the lineto absolute).
function normalizeLeadingMove(d) {
  const sc = new PathScanner(d)
  const cmd = sc.command()
  if (cmd !== 'm') return d
  const x = sc.number(), y = sc.number()
  sc.skipSep()
  const rest = d.slice(sc.i)
  if (!rest) return `M${x} ${y}`
  const implicitLineto = /^[-+.\d]/.test(rest)
  return `M${x} ${y}${implicitLineto ? 'l' : ''}${rest}`
}

function svgToPath(name, markup) {
  // The root <svg> carries only styling; the drawables are its direct children.
  // Lucide never nests groups, so a flat scan is complete — and the guard below
  // makes sure of it rather than assuming it.
  const inner = markup.replace(/^<svg\b[^>]*>/, '').replace(/<\/svg>$/, '')
  const stray = inner.replace(/<\/?[a-zA-Z0-9-]+\b[^>]*>/g, '').trim()
  if (stray) throw new Error(`unexpected text content in ${name}`)

  const parts = []
  for (const m of inner.matchAll(/<([a-zA-Z0-9-]+)\b([^>]*?)\/?>(?:<\/\1>)?/g)) {
    const tag = m[1]
    if (!DRAWN.has(tag)) throw new Error(`unsupported element <${tag}> in ${name}`)
    parts.push(normalizeLeadingMove(elementToPath(tag, parseAttrs(m[2]))))
  }
  if (parts.length === 0) throw new Error(`no drawable elements in ${name}`)
  return parts.join(' ')
}

// ── Path validation: a JS mirror of LucidePath.swift ────────────────────────
// Interprets the path data exactly as the Swift parser will — same tokenizer,
// same implicit-command rules, same arc conversion — and returns the bounding
// box of every on-curve point. Kept in lockstep with LucidePath.swift BY HAND;
// if you change one, change the other.

// A cursor-based scanner, NOT a context-free tokenizer. This distinction is
// load-bearing: SVG allows an arc's two flags to be juxtaposed with the next
// number ("a2.5 2.5 0 011.3-2.4" is flags 0 and 1 followed by x=1.3), and
// Lucide's minified paths use that form constantly. A tokenizer that greedily
// reads "011.3" as one number silently corrupts every coordinate after it —
// so flags must be read as single characters, which requires knowing you are
// inside an arc's argument list. LucidePath.swift scans identically.
const CMD_CHARS = 'MmLlHhVvCcSsQqTtAaZz'

class PathScanner {
  constructor(s) { this.s = s; this.i = 0 }

  skipSep() {
    while (this.i < this.s.length && /[\s,]/.test(this.s[this.i])) this.i++
  }

  atEnd() { this.skipSep(); return this.i >= this.s.length }

  // The command letter at the cursor, or null if a number is next.
  command() {
    this.skipSep()
    const ch = this.s[this.i]
    if (ch !== undefined && CMD_CHARS.includes(ch)) { this.i++; return ch }
    return null
  }

  number() {
    this.skipSep()
    const re = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y
    re.lastIndex = this.i
    const m = re.exec(this.s)
    if (!m) throw new Error(`expected number at "${this.s.slice(this.i, this.i + 12)}"`)
    this.i = re.lastIndex
    return Number(m[0])
  }

  flag() {
    this.skipSep()
    const ch = this.s[this.i]
    if (ch !== '0' && ch !== '1') throw new Error(`expected arc flag 0/1, got "${ch}"`)
    this.i++
    return ch === '1'
  }
}

// Endpoint-to-center conversion per SVG spec F.6.5, then sample the arc. Only
// the sampled points feed the bbox; the Swift side converts the same centre
// parameterization into cubic Béziers.
function arcPoints(x1, y1, rx, ry, phiDeg, largeArc, sweep, x2, y2) {
  if (rx === 0 || ry === 0) return [[x2, y2]]
  rx = Math.abs(rx); ry = Math.abs(ry)
  const phi = (phiDeg * Math.PI) / 180
  const cosP = Math.cos(phi), sinP = Math.sin(phi)
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = cosP * dx + sinP * dy
  const y1p = -sinP * dx + cosP * dy
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lambda > 1) { const s = Math.sqrt(lambda); rx *= s; ry *= s }
  const sign = largeArc !== sweep ? 1 : -1
  const numer = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const denom = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  const co = sign * Math.sqrt(Math.max(0, numer / denom))
  const cxp = co * (rx * y1p) / ry
  const cyp = co * (-ry * x1p) / rx
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2
  const angle = (ux, uy, vx, vy) => {
    const dot = ux * vx + uy * vy
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy)
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)))
    if (ux * vy - uy * vx < 0) a = -a
    return a
  }
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dTheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI
  const pts = []
  const steps = Math.max(4, Math.ceil(Math.abs(dTheta) / (Math.PI / 16)))
  for (let i = 1; i <= steps; i++) {
    const t = theta1 + (dTheta * i) / steps
    pts.push([
      cx + rx * Math.cos(phi) * Math.cos(t) - ry * Math.sin(phi) * Math.sin(t),
      cy + rx * Math.sin(phi) * Math.cos(t) + ry * Math.cos(phi) * Math.sin(t),
    ])
  }
  return pts
}

function interpretPath(d) {
  const sc = new PathScanner(d)
  let cmd = null
  let cx = 0, cy = 0            // current point
  let sx = 0, sy = 0            // subpath start
  let pcx = null, pcy = null    // previous control point (for S/T reflection)
  let prevCmd = null
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  const mark = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('non-finite point')
    box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x)
    box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y)
  }

  while (!sc.atEnd()) {
    const next = sc.command()
    if (next !== null) {
      cmd = next
    } else if (cmd === null) {
      throw new Error('number before any command')
    } else if (cmd === 'M') cmd = 'L'   // implicit repeat: M's extras are L
    else if (cmd === 'm') cmd = 'l'
    else if (cmd === 'Z' || cmd === 'z') throw new Error('number after Z')

    const upper = cmd.toUpperCase()
    const rel = cmd !== upper

    switch (upper) {
      case 'M': {
        const a1 = sc.number(), a2 = sc.number()
        cx = rel ? cx + a1 : a1; cy = rel ? cy + a2 : a2
        sx = cx; sy = cy; mark(cx, cy); pcx = pcy = null
        break
      }
      case 'L': {
        const a1 = sc.number(), a2 = sc.number()
        cx = rel ? cx + a1 : a1; cy = rel ? cy + a2 : a2
        mark(cx, cy); pcx = pcy = null
        break
      }
      case 'H': { const a = sc.number(); cx = rel ? cx + a : a; mark(cx, cy); pcx = pcy = null; break }
      case 'V': { const a = sc.number(); cy = rel ? cy + a : a; mark(cx, cy); pcx = pcy = null; break }
      case 'C': {
        const a1 = sc.number(), a2 = sc.number(), a3 = sc.number()
        const a4 = sc.number(), a5 = sc.number(), a6 = sc.number()
        const c1x = rel ? cx + a1 : a1, c1y = rel ? cy + a2 : a2
        const c2x = rel ? cx + a3 : a3, c2y = rel ? cy + a4 : a4
        cx = rel ? cx + a5 : a5; cy = rel ? cy + a6 : a6
        mark(c1x, c1y); mark(c2x, c2y); mark(cx, cy)
        pcx = c2x; pcy = c2y
        break
      }
      case 'S': {
        const refl = prevCmd && 'CcSs'.includes(prevCmd) && pcx !== null
        const c1x = refl ? 2 * cx - pcx : cx
        const c1y = refl ? 2 * cy - pcy : cy
        const a1 = sc.number(), a2 = sc.number(), a3 = sc.number(), a4 = sc.number()
        const c2x = rel ? cx + a1 : a1, c2y = rel ? cy + a2 : a2
        cx = rel ? cx + a3 : a3; cy = rel ? cy + a4 : a4
        mark(c1x, c1y); mark(c2x, c2y); mark(cx, cy)
        pcx = c2x; pcy = c2y
        break
      }
      case 'Q': {
        const a1 = sc.number(), a2 = sc.number(), a3 = sc.number(), a4 = sc.number()
        const qx = rel ? cx + a1 : a1, qy = rel ? cy + a2 : a2
        cx = rel ? cx + a3 : a3; cy = rel ? cy + a4 : a4
        mark(qx, qy); mark(cx, cy)
        pcx = qx; pcy = qy
        break
      }
      case 'T': {
        const refl = prevCmd && 'QqTt'.includes(prevCmd) && pcx !== null
        const qx = refl ? 2 * cx - pcx : cx
        const qy = refl ? 2 * cy - pcy : cy
        const a1 = sc.number(), a2 = sc.number()
        cx = rel ? cx + a1 : a1; cy = rel ? cy + a2 : a2
        mark(qx, qy); mark(cx, cy)
        pcx = qx; pcy = qy
        break
      }
      case 'A': {
        const rx = sc.number(), ry = sc.number(), rot = sc.number()
        const laf = sc.flag(), sf = sc.flag()
        const a6 = sc.number(), a7 = sc.number()
        const ex = rel ? cx + a6 : a6, ey = rel ? cy + a7 : a7
        for (const [px, py] of arcPoints(cx, cy, rx, ry, rot, laf, sf, ex, ey)) mark(px, py)
        cx = ex; cy = ey
        pcx = pcy = null
        break
      }
      case 'Z': { cx = sx; cy = sy; pcx = pcy = null; break }
    }
    prevCmd = cmd
  }
  return box
}

// ── Main ────────────────────────────────────────────────────────────────────

const lines = []
const aliasLines = []
const failures = []
const outOfBox = []
let maxLen = 0
const bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }

for (const [component, names] of iconGroups()) {
  const name = canonicalName(names)
  try {
    const markup = renderToStaticMarkup(createElement(component))
    if (!/viewBox="0 0 24 24"/.test(markup)) throw new Error('unexpected viewBox')
    const d = svgToPath(name, markup)
    if (/["\\]/.test(d)) throw new Error('path data contains a quote or backslash')
    const box = interpretPath(d)
    // Stroke centerlines live inside the 24x24 viewBox; allow slack for control
    // points, which may legitimately overshoot the drawn curve. A breach is
    // recorded, not fatal per se: the Swift renderer clips to the viewBox (as
    // SVG itself does), so a genuinely stray segment in upstream icon data —
    // this lucide version ships one in SaveOff — is invisible, exactly as it is
    // on Android where vector drawables clip to the viewport. The count check
    // below is what turns "many breaches" back into a hard failure, because
    // many at once is the signature of a parser bug, not of upstream data.
    const TOL = 6
    if (box.minX < -TOL || box.minY < -TOL || box.maxX > 24 + TOL || box.maxY > 24 + TOL)
      outOfBox.push(`${name}: ${JSON.stringify(box)}`)
    bbox.minX = Math.min(bbox.minX, box.minX); bbox.maxX = Math.max(bbox.maxX, box.maxX)
    bbox.minY = Math.min(bbox.minY, box.minY); bbox.maxY = Math.max(bbox.maxY, box.maxY)
    maxLen = Math.max(maxLen, d.length)
    lines.push(`${name} ${d}`)
    for (const other of names) {
      if (other !== name) aliasLines.push(`${other} ${name}`)
    }
  } catch (err) {
    failures.push(`${name}: ${err.message}`)
  }
}

const MAX_OUT_OF_BOX = 5
if (outOfBox.length > MAX_OUT_OF_BOX) {
  failures.push(
    `${outOfBox.length} icons out of viewBox (> ${MAX_OUT_OF_BOX}; parser bug, not upstream data):`,
    ...outOfBox,
  )
} else if (outOfBox.length > 0) {
  console.warn(`note: ${outOfBox.length} icon(s) exceed the viewBox (upstream data; clipped at render):`)
  for (const w of outOfBox) console.warn('  ' + w)
}

if (failures.length > 0) {
  console.error(`FAILED for ${failures.length} icon(s):`)
  for (const f of failures) console.error('  ' + f)
  process.exit(1)
}

lines.sort() // deterministic output → stable diffs
aliasLines.sort()

const swift = `// Generated by scripts/gen-lucide-swift.mjs — do not edit by hand.
// Regenerate with: npm run gen:icons:ios
//
// blob has one line per icon: its canonical Lucide PascalCase name, a space, then
// the icon's complete SVG path data with every shape element (circle, rect, line,
// …) pre-converted to path commands. aliases has one line per other name chore.icon
// can store: that name, a space, then the canonical one. Parsed lazily by
// LucidePath.swift. Single string literals on purpose: Swift compiles them in
// negligible time, where a ${lines.length}-entry dictionary literal would crawl
// through the type checker.

enum LucideIconData {
    static let blob: String = """
${lines.join('\n')}
"""

    static let aliases: String = """
${aliasLines.join('\n')}
"""
}
`

await writeFile(OUT_FILE, swift)
console.log(`icons: ${lines.length}, aliases: ${aliasLines.length}`)
console.log(`longest path: ${maxLen} chars`)
console.log(`combined bbox: [${bbox.minX.toFixed(2)}, ${bbox.minY.toFixed(2)}] .. [${bbox.maxX.toFixed(2)}, ${bbox.maxY.toFixed(2)}]`)
console.log(`wrote ${OUT_FILE} (${(swift.length / 1024).toFixed(0)} KB)`)
