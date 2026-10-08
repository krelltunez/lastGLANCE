import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
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

const IOS_CATALOGS = ['ios/App/GlanceWidgets/Localizable.xcstrings', 'ios/App/ShareExtension/Localizable.xcstrings']

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

  it.each(translatable)('%s is in every iOS string catalog', (lng) => {
    for (const rel of IOS_CATALOGS) {
      const strings = JSON.parse(readFileSync(join(ROOT, rel), 'utf8')).strings as Record<
        string,
        { localizations?: Record<string, unknown> }
      >
      const seen = Object.values(strings).some((e) => lng in (e.localizations ?? {}))
      expect(seen, `${rel} has no ${lng}`).toBe(true)
    }
  })
})
