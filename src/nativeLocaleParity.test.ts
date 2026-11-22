import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { languages } from './locales'

/**
 * Ported from dayGLANCE. The web bundles, Android's locale list and string
 * resources, and the iOS string catalogs are separate surfaces that have to
 * agree. locales.test.ts checks the web bundles against each other and
 * iosStrings.test.ts checks the catalogs it is told about; neither notices
 * the web side gaining a language the native sides lack.
 *
 * locales_config.xml is also what Android 13+ shows under Settings > Apps >
 * lastGLANCE > Language, and what the in-app picker hands to the system
 * (issue #327), so a language missing from it cannot be chosen there.
 */
const ROOT = join(__dirname, '..')
const ANDROID_RES = join(ROOT, 'android/app/src/main/res')
const LOCALES_CONFIG = join(ANDROID_RES, 'xml/locales_config.xml')

// Android resource qualifier for a web tag. Both Portuguese standards share
// values-pt (European) for the native strings.
const ANDROID_QUALIFIER: Record<string, string> = { 'zh-CN': 'zh-rCN', 'pt-BR': 'pt', 'pt-PT': 'pt' }
const androidDirFor = (tag: string) => `values-${ANDROID_QUALIFIER[tag] ?? tag}`

// iOS names Simplified Chinese zh-Hans where the web bundle says zh-CN.
const IOS_LOCALIZATION: Record<string, string> = { 'zh-CN': 'zh-Hans' }
const INFO_PLIST = join(ROOT, 'ios/App/App/Info.plist')

// Every string catalog in the iOS project, found rather than listed: a listed
// set left out the app's own catalog, so that one was never held to the web
// languages here. Build output and dependencies are skipped.
const SKIP = new Set(['build', 'Pods', 'DerivedData', '.build', 'node_modules'])
function findCatalogs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? SKIP.has(d.name) ? [] : findCatalogs(join(dir, d.name))
      : d.name.endsWith('.xcstrings') ? [relative(ROOT, join(dir, d.name))] : [],
  )
}
const IOS_CATALOGS = findCatalogs(join(ROOT, 'ios/App')).sort()

interface CatalogEntry {
  shouldTranslate?: boolean
  localizations?: Record<string, { stringUnit?: { state?: string; value?: string } }>
}
interface Catalog { strings: Record<string, CatalogEntry> }

/**
 * The keys of a catalog that would show English to a `lng` user: every key
 * Xcode is asked to translate (brand words and bare numbers are marked
 * shouldTranslate false) needs a value in that language, marked translated.
 * Catalogs use the web tag (zh-CN), unlike Info.plist.
 */
function untranslatedIn(catalog: Catalog, lng: string): string[] {
  return Object.entries(catalog.strings)
    .filter(([, e]) => e.shouldTranslate !== false)
    .filter(([, e]) => {
      const unit = e.localizations?.[lng]?.stringUnit
      return !unit?.value || unit.state !== 'translated'
    })
    .map(([key]) => key)
}

const declared = () =>
  [...readFileSync(LOCALES_CONFIG, 'utf8').matchAll(/<locale\s+android:name="([^"]+)"/g)].map((m) => m[1])

describe('native locales track the shipped web locales', () => {
  const translatable = languages.filter((l) => l !== 'en')

  it('the manifest points Android at the locale list', () => {
    const manifest = readFileSync(join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8')
    expect(manifest).toContain('android:localeConfig="@xml/locales_config"')
  })

  it('locales_config.xml lists exactly the web languages', () => {
    expect([...declared()].sort(), 'Settings > Language would offer a different list than the app').toEqual(
      [...languages].sort(),
    )
  })

  // The iOS counterpart of locales_config.xml: without it the app bundle has
  // no localizations iOS can see (the UI is web content), so Settings offers
  // no per-app Language row and widgets can only follow the system language.
  it('Info.plist declares exactly the web languages to iOS', () => {
    const plist = readFileSync(INFO_PLIST, 'utf8')
    const block = plist.match(/<key>CFBundleLocalizations<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? ''
    const declared = [...block.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1]).sort()
    expect(declared, 'Settings > lastGLANCE > Language would offer a different list than the app').toEqual(
      languages.map((l) => IOS_LOCALIZATION[l] ?? l).sort(),
    )
  })

  it.each(translatable)('%s has Android string resources', (lng) => {
    expect(existsSync(join(ANDROID_RES, androidDirFor(lng))), `no ${androidDirFor(lng)}/`).toBe(true)
  })

  // Pinned so the search cannot quietly find nothing, and so a new catalog
  // stops here until it is also added to the lists that format and check it.
  it('finds the three catalogs the project ships', () => {
    expect(
      IOS_CATALOGS,
      'a catalog was added or moved: update CATALOGS in scripts/format-xcstrings.mjs and src/iosStrings.test.ts, then this list',
    ).toEqual([
      'ios/App/App/Localizable.xcstrings',
      'ios/App/GlanceWidgets/Localizable.xcstrings',
      'ios/App/ShareExtension/Localizable.xcstrings',
    ])
  })

  it.each(translatable)('%s is complete in every iOS string catalog', (lng) => {
    const missing = IOS_CATALOGS.flatMap((rel) =>
      untranslatedIn(JSON.parse(readFileSync(join(ROOT, rel), 'utf8')), lng).map((key) => `${rel}: ${key}`),
    )
    expect(missing, `these would show English to ${lng} users on iOS`).toEqual([])
  })
})

// The check above replaced one that passed when any single key had the
// language, so a catalog with one string translated counted as done.
describe('catalog completeness (negative controls)', () => {
  const ja = (value: string, state = 'translated') => ({ ja: { stringUnit: { state, value } } })
  const de = { de: { stringUnit: { state: 'translated', value: 'Erledigt' } } }

  it('fails a catalog with only one key translated', () => {
    const catalog: Catalog = {
      strings: {
        Done: { localizations: { ...ja('完了'), ...de } },
        Streak: { localizations: de },
        'Active days': {},
      },
    }
    expect(untranslatedIn(catalog, 'ja')).toEqual(['Streak', 'Active days'])
  })

  it('fails a value Xcode has not marked translated', () => {
    expect(untranslatedIn({ strings: { Done: { localizations: ja('完了', 'needs_review') } } }, 'ja')).toEqual(['Done'])
    expect(untranslatedIn({ strings: { Done: { localizations: ja('') } } }, 'ja')).toEqual(['Done'])
  })

  it('passes a complete catalog, keys marked shouldTranslate false aside', () => {
    expect(
      untranslatedIn({ strings: { Done: { localizations: ja('完了') }, lastGLANCE: { shouldTranslate: false } } }, 'ja'),
    ).toEqual([])
  })
})
