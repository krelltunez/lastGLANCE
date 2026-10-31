import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { EUROPEAN_ONLY, BRAZILIAN_ONLY } from './ptMarkers'

/**
 * CI cannot run Xcode, so the widget string catalog and its project wiring
 * are validated here instead: a language dropped from a key ships English on
 * that device, a format specifier lost in translation truncates or crashes
 * at render, a duplicate pbxproj object id corrupts the project the next
 * time Xcode loads it, and a wrong-standard Portuguese word is exactly what
 * the variant guardrail exists to stop.
 */
const IOS = join(__dirname, '../ios/App')
const CATALOGS = [
  // Kept in step with scripts/format-xcstrings.mjs, which formats the same set.
  'App/Localizable.xcstrings',
  'GlanceWidgets/Localizable.xcstrings',
  'ShareExtension/Localizable.xcstrings',
]
const PBXPROJ = join(IOS, 'App.xcodeproj/project.pbxproj')

const LANGS = ['de', 'es', 'fr', 'it', 'pt-PT', 'pt-BR', 'zh-CN', 'pl', 'uk']

interface StringUnit { stringUnit: { state: string; value: string } }
// A plural entry: the value is "%#@name@" and the named substitution consumes
// the argument, choosing a form by the language's plural rules.
interface Substitution {
  argNum: number
  formatSpecifier: string
  variations: { plural: Record<string, StringUnit> }
}
interface Localization extends StringUnit { substitutions?: Record<string, Substitution> }
interface CatalogEntry { localizations?: Record<string, Localization>; shouldTranslate?: boolean }
interface Catalog { sourceLanguage: string; strings: Record<string, CatalogEntry>; version: string }

const specifiers = (v: string) => (v.match(/%(lld|@|d)/g) ?? []).sort().join(',')

// What a localized value consumes: its own specifiers, plus one argument per
// %#@name@ substitution in the substitution's declared type. A plural form may
// print its argument or leave it out (the heatmap captions sit under a figure
// drawn separately), so the forms themselves are checked separately.
function consumed(loc: Localization): string {
  const subs = [...loc.stringUnit.value.matchAll(/%#@(\w+)@/g)].map((m) => m[1])
  const own = loc.stringUnit.value.replace(/%#@\w+@/g, '')
  return [...(own.match(/%(lld|@|d)/g) ?? []), ...subs.map((n) => `%${loc.substitutions?.[n]?.formatSpecifier}`)]
    .sort()
    .join(',')
}

// Every user-visible string in a localization, plural forms included.
const textOf = (loc?: Localization) =>
  [loc?.stringUnit?.value ?? '', ...Object.values(loc?.substitutions ?? {}).flatMap((sub) =>
    Object.values(sub.variations.plural).map((f) => f.stringUnit.value))].join(' | ')

describe.each(CATALOGS)('%s', (rel) => {
  const catalog: Catalog = JSON.parse(readFileSync(join(IOS, rel), 'utf8'))
  const entries = Object.entries(catalog.strings)
  it('parses and declares en as the source language', () => {
    expect(catalog.sourceLanguage).toBe('en')
    expect(entries.length).toBeGreaterThan(2)
  })

  it.each(LANGS)('every key carries a translated %s value', (lng) => {
    const missing = entries
      .filter(([, e]) => e.localizations && !e.localizations[lng]?.stringUnit?.value)
      .map(([k]) => k)
    expect(missing, `these keys would render English on ${lng} devices`).toEqual([])
  })

  // A key with no translations is a brand word or a bare number the compiler
  // extracts from the Swift. It stays in the catalog (or Xcode adds it back on
  // the next build) and is marked so Xcode does not list it as untranslated.
  it('marks every untranslated key shouldTranslate false', () => {
    const unmarked = entries.filter(([, e]) => !e.localizations && e.shouldTranslate !== false).map(([k]) => k)
    expect(unmarked).toEqual([])
  })

  it('keeps every format specifier in every translation', () => {
    const bad: string[] = []
    for (const [key, e] of entries) {
      for (const [lng, unit] of Object.entries(e.localizations ?? {})) {
        if (consumed(unit) !== specifiers(key)) bad.push(`${lng}: ${key}`)
      }
    }
    expect(bad, 'specifier mismatches truncate or crash at render').toEqual([])
  })

  // Plural forms are chosen at runtime, so a missing category only shows up
  // on a device: a count of 5 in Polish asks for "many", and without it iOS
  // falls back to "other" and gets the noun wrong. Counts here can be 0 (an
  // empty heatmap window), which is "many" in Polish and Ukrainian and "one"
  // in French, so 0 is included.
  it('defines every plural form each language selects', () => {
    const bad: string[] = []
    for (const [key, e] of entries) {
      for (const [lng, loc] of Object.entries(e.localizations ?? {})) {
        for (const [name, sub] of Object.entries(loc.substitutions ?? {})) {
          const forms = sub.variations.plural
          const rules = new Intl.PluralRules(lng)
          const selected = new Set<string>(['other'])
          for (let n = 0; n <= 1000; n++) selected.add(rules.select(n))
          for (const cat of selected) if (!forms[cat]?.stringUnit.value) bad.push(`${lng}: ${key} lacks ${name}.${cat}`)
          for (const [cat, form] of Object.entries(forms)) {
            if (!selected.has(cat)) bad.push(`${lng}: ${key} has ${name}.${cat}, which ${lng} never selects`)
            if (!/^[^%]*(%(lld|d)[^%]*)?$/.test(form.stringUnit.value)) bad.push(`${lng}: ${key} ${name}.${cat} has a stray specifier`)
          }
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('holds pt-PT to the European standard', () => {
    const violations: string[] = []
    for (const [key, e] of entries) {
      const v = textOf(e.localizations?.['pt-PT'])
      for (const [marker, pattern] of Object.entries(BRAZILIAN_ONLY)) {
        if (pattern.test(v)) violations.push(`${key}: "${v}" — ${marker}`)
      }
    }
    expect(violations).toEqual([])
  })

  it('holds pt-BR to the Brazilian standard', () => {
    const violations: string[] = []
    for (const [key, e] of entries) {
      const v = textOf(e.localizations?.['pt-BR'])
      for (const [marker, pattern] of Object.entries(EUROPEAN_ONLY)) {
        if (pattern.test(v)) violations.push(`${key}: "${v}" — ${marker}`)
      }
    }
    expect(violations).toEqual([])
  })
})

// Xcode rewrites a catalog in its own JSON shape whenever a build syncs it,
// so a hand-formatted file shows up dirty after every build.
it('keeps both catalogs in the shape Xcode saves them', () => {
  expect(() =>
    execFileSync('node', [join(__dirname, '../scripts/format-xcstrings.mjs'), '--check'], { stdio: 'pipe' }),
  ).not.toThrow()
})

describe('pbxproj wiring', () => {
  const pbx = readFileSync(PBXPROJ, 'utf8')

  it('defines every object id exactly once', () => {
    const defined = [...pbx.matchAll(/^\t\t([0-9A-F]{24}) [^=]*= \{/gm)].map((m) => m[1])
    const dupes = defined.filter((id, i) => defined.indexOf(id) !== i)
    expect(dupes, 'duplicate ids corrupt the project when Xcode next loads it').toEqual([])
  })

  // Counted per file name rather than per catalog, because three targets ship a
  // catalog called Localizable.xcstrings and the project file names them all
  // the same way. A catalog that is committed but never registered compiles
  // into nothing and every string falls back to English.
  it('registers every catalog as a file, a build file, and a resource', () => {
    const expected = new Map<string, number>()
    for (const rel of CATALOGS) {
      const name = rel.split('/').pop()!
      expected.set(name, (expected.get(name) ?? 0) + 1)
    }
    for (const [name, n] of expected) {
      const esc = name.split('.').join('\\.')
      expect(
        pbx.match(new RegExp(`/\\* ${esc} \\*/ = \\{isa = PBXFileReference`, 'g'))?.length,
        `${name} file references`,
      ).toBe(n)
      expect(
        pbx.match(new RegExp(`/\\* ${esc} in Resources \\*/ = \\{isa = PBXBuildFile`, 'g'))?.length,
        `${name} build files`,
      ).toBe(n)
      // Each one is named twice: the build file, and the Resources phase entry.
      expect(pbx.match(new RegExp(`${esc} in Resources \\*/`, 'g'))?.length, `${name} resource entries`).toBe(n * 2)
    }
  })

  it('declares every catalog language in knownRegions', () => {
    const region = pbx.slice(pbx.indexOf('knownRegions'), pbx.indexOf(');', pbx.indexOf('knownRegions')))
    for (const lng of LANGS) expect(region, `knownRegions missing ${lng}`).toContain(lng)
  })
})
