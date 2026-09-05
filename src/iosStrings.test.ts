import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
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
const CATALOGS = ['GlanceWidgets/Localizable.xcstrings', 'ShareExtension/Localizable.xcstrings']
const PBXPROJ = join(IOS, 'App.xcodeproj/project.pbxproj')

const LANGS = ['de', 'es', 'fr', 'it', 'pt-PT', 'pt-BR', 'zh-CN']

interface StringUnit { stringUnit: { state: string; value: string } }
interface CatalogEntry { localizations?: Record<string, StringUnit> }
interface Catalog { sourceLanguage: string; strings: Record<string, CatalogEntry>; version: string }

const specifiers = (v: string) => (v.match(/%(lld|@|d)/g) ?? []).sort().join(',')

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

  it('keeps every format specifier in every translation', () => {
    const bad: string[] = []
    for (const [key, e] of entries) {
      for (const [lng, unit] of Object.entries(e.localizations ?? {})) {
        if (specifiers(unit.stringUnit.value) !== specifiers(key)) bad.push(`${lng}: ${key}`)
      }
    }
    expect(bad, 'specifier mismatches truncate or crash at render').toEqual([])
  })

  it('holds pt-PT to the European standard', () => {
    const violations: string[] = []
    for (const [key, e] of entries) {
      const v = e.localizations?.['pt-PT']?.stringUnit?.value ?? ''
      for (const [marker, pattern] of Object.entries(BRAZILIAN_ONLY)) {
        if (pattern.test(v)) violations.push(`${key}: "${v}" — ${marker}`)
      }
    }
    expect(violations).toEqual([])
  })

  it('holds pt-BR to the Brazilian standard', () => {
    const violations: string[] = []
    for (const [key, e] of entries) {
      const v = e.localizations?.['pt-BR']?.stringUnit?.value ?? ''
      for (const [marker, pattern] of Object.entries(EUROPEAN_ONLY)) {
        if (pattern.test(v)) violations.push(`${key}: "${v}" — ${marker}`)
      }
    }
    expect(violations).toEqual([])
  })
})

describe('pbxproj wiring', () => {
  const pbx = readFileSync(PBXPROJ, 'utf8')

  it('defines every object id exactly once', () => {
    const defined = [...pbx.matchAll(/^\t\t([0-9A-F]{24}) [^=]*= \{/gm)].map((m) => m[1])
    const dupes = defined.filter((id, i) => defined.indexOf(id) !== i)
    expect(dupes, 'duplicate ids corrupt the project when Xcode next loads it').toEqual([])
  })

  it('registers both catalogs as files, build files, and resources', () => {
    expect(pbx.match(/\/\* Localizable\.xcstrings \*\/ = \{isa = PBXFileReference/g)?.length).toBe(2)
    expect(pbx.match(/\/\* Localizable\.xcstrings in Resources \*\/ = \{isa = PBXBuildFile/g)?.length).toBe(2)
    expect(pbx.match(/Localizable\.xcstrings in Resources \*\//g)?.length).toBe(4)
  })

  it('declares every catalog language in knownRegions', () => {
    const region = pbx.slice(pbx.indexOf('knownRegions'), pbx.indexOf(');', pbx.indexOf('knownRegions')))
    for (const lng of LANGS) expect(region, `knownRegions missing ${lng}`).toContain(lng)
  })
})
