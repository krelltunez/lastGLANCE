import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { languages, loaders, resolveLanguage } from './locales'

// de/es/fr/it/pt sat 8 keys behind en — the backup restore confirmation and
// the GLANCEvault intents errors rendered in English for every non-English
// user. The backlog is translated, so this is a strict parity check: a key
// added to en without translations fails here instead of silently falling back.
describe('locale bundles', () => {
  const EXPECTED = ['de', 'en', 'es', 'fr', 'it', 'ja', 'pl', 'pt-BR', 'pt-PT', 'uk', 'zh-CN']
  const TRANSLATED = EXPECTED.filter((l) => l !== 'en')

  const bundles: Record<string, Record<string, unknown>> = {}
  beforeAll(async () => {
    await Promise.all(
      EXPECTED.map(async (lng) => {
        bundles[lng] = await loaders[lng]()
      }),
    )
  })

  const flatten = (obj: Record<string, unknown>, prefix = ''): [string, unknown][] =>
    Object.entries(obj).flatMap(([k, v]) => {
      const key = prefix ? `${prefix}.${k}` : k
      return v && typeof v === 'object' && !Array.isArray(v)
        ? flatten(v as Record<string, unknown>, key)
        : [[key, v] as [string, unknown]]
    })

  const keysOf = (lng: string) => new Set(flatten(bundles[lng]).map(([k]) => k))

  it('exposes every shipped language', () => {
    expect(languages).toEqual(EXPECTED)
  })

  // completionsLabel routes 0 to its own key instead of a `_zero` plural
  // suffix, on the grounds that no shipped language has a CLDR zero
  // category. Pin that here so a language that does (Arabic, Latvian, Welsh)
  // fails loudly when it is added instead of quietly reading "0 completions".
  it('ships no language with a CLDR zero plural category', () => {
    for (const lng of languages) {
      expect(new Intl.PluralRules(lng).resolvedOptions().pluralCategories, lng).not.toContain('zero')
    }
  })

  // Shared by the detector (convertDetectedLanguage) and the picker's value —
  // the two must agree, or the UI renders one language while the picker
  // displays another.
  describe('resolveLanguage', () => {
    it('passes through a tag that is already shipped', () => {
      expect(resolveLanguage('de')).toBe('de')
      expect(resolveLanguage('pt-BR')).toBe('pt-BR')
    })

    it('matches a shipped tag regardless of case', () => {
      expect(resolveLanguage('DE')).toBe('de')
      expect(resolveLanguage('pt-br')).toBe('pt-BR')
      expect(resolveLanguage('PT-BR')).toBe('pt-BR')
    })

    // The regression the pt split must not cause. Portuguese shipped as a
    // single "pt" locale (European) before the split, so every Portuguese
    // user has that value cached in localStorage; without the mapping they
    // would silently land in English.
    it('moves the pre-split "pt" to European rather than English', () => {
      expect(resolveLanguage('pt')).toBe('pt-PT')
    })

    it('sends an unshipped Portuguese region to European', () => {
      expect(resolveLanguage('pt-AO')).toBe('pt-PT')
      expect(resolveLanguage('pt-MZ')).toBe('pt-PT')
    })

    // Deliberate: Simplified is the only Chinese we ship, and for a
    // Traditional-script reader (Taiwan, Hong Kong, Macau) it is closer than
    // English. When a zh-TW locale lands, zh-TW resolves to itself and this
    // test fails on purpose — that is the moment to add `zh: 'zh-CN'` (or
    // whichever variant should own the bare tag) to REGIONAL_DEFAULTS and to
    // decide where zh-HK / zh-MO go, since the generic fallback would
    // otherwise hand them the alphabetically-first variant (zh-CN).
    it('sends every Chinese tag to Simplified until a Traditional locale ships', () => {
      expect(resolveLanguage('zh')).toBe('zh-CN')
      expect(resolveLanguage('zh-Hans-CN')).toBe('zh-CN')
      expect(resolveLanguage('zh-SG')).toBe('zh-CN')
      expect(resolveLanguage('zh-TW')).toBe('zh-CN')
      expect(resolveLanguage('zh-HK')).toBe('zh-CN')
      expect(resolveLanguage('zh-Hant-TW')).toBe('zh-CN')
    })

    it('reduces a regional tag to a base language that is shipped', () => {
      expect(resolveLanguage('en-US')).toBe('en')
      expect(resolveLanguage('de-AT')).toBe('de')
    })

    it('falls back to en for a language that is not shipped', () => {
      expect(resolveLanguage('ko')).toBe('en')
      expect(resolveLanguage('zz-ZZ')).toBe('en')
    })

    it('handles a missing or non-string value', () => {
      expect(resolveLanguage(undefined)).toBe('en')
      expect(resolveLanguage(null)).toBe('en')
      expect(resolveLanguage('')).toBe('en')
      expect(resolveLanguage(42)).toBe('en')
    })

    it('prefers any variant of the right language over English', () => {
      expect(resolveLanguage('pt', ['en', 'pt-BR'])).toBe('pt-BR')
    })

    it('falls back to the first option when en is not shipped', () => {
      expect(resolveLanguage('ja', ['de', 'fr'])).toBe('de')
    })

    it('always returns something the picker can render', () => {
      for (const reported of ['en', 'pt', 'pt-AO', 'de-AT', 'zh-TW', 'zz', '', undefined]) {
        expect(languages).toContain(resolveLanguage(reported))
      }
    })
  })

  it.each(EXPECTED)('%s resolves to a non-empty bundle', (lng) => {
    expect(bundles[lng]).toBeTypeOf('object')
    expect(Object.keys(bundles[lng]).length).toBeGreaterThan(0)
  })

  // Plural keys differ by language on purpose: English has one/other, Polish
  // and Ukrainian need one/few/many/other, and Chinese selects only other.
  // Comparing key-for-key would force a language to carry forms its rules never
  // select, or forbid the ones they do, so plural keys are compared by family
  // ("heatmap.completions") and each language is held to its own categories.
  const PLURAL = /_(zero|one|two|few|many|other)$/
  const family = (key: string) => key.replace(PLURAL, '')
  const categoryOf = (key: string) => key.match(PLURAL)?.[1]
  const isPlural = (key: string) => PLURAL.test(key)
  const enFamilies = () => new Set([...keysOf('en')].filter(isPlural).map(family))
  const categoriesOf = (lng: string) =>
    new Intl.PluralRules(lng).resolvedOptions().pluralCategories as string[]

  describe('coverage against en', () => {
    it.each(TRANSLATED)('%s covers every key in en', (lng) => {
      const have = new Set([...keysOf(lng)].map(family))
      const missing = [...keysOf('en')].filter((k) => (isPlural(k) ? !have.has(family(k)) : !keysOf(lng).has(k)))
      expect(
        missing,
        `${lng} is missing keys that en has — translate them:\n  ${missing.slice(0, 10).join('\n  ')}`,
      ).toEqual([])
    })

    // A plural form en has no key for (Polish `_few`) is allowed only when en
    // carries the family and the language's own rules select that category —
    // a stray `_few` in German would never be read.
    it.each(TRANSLATED)('%s carries no keys that en does not', (lng) => {
      const known = enFamilies()
      const own = categoriesOf(lng)
      const extra = [...keysOf(lng)].filter(
        (k) => !keysOf('en').has(k) && !(isPlural(k) && known.has(family(k)) && own.includes(categoryOf(k)!)),
      )
      expect(extra, `${lng} has keys absent from en`).toEqual([])
    })

    // The other half of allowing different plural keys: each language must
    // actually define the forms its rules select, or i18next falls back to the
    // base key and a count like 3 renders with the wrong noun. Scoped to counts
    // the app can produce (0-1000): es/fr/it/pt reserve "many" for millions,
    // which drops out on its own instead of needing a list of exempt languages.
    it.each(TRANSLATED)('%s defines every plural category its rules select', (lng) => {
      const rules = new Intl.PluralRules(lng)
      const selected = new Set<string>()
      for (let n = 0; n <= 1000; n++) selected.add(rules.select(n))
      const problems = [...enFamilies()].flatMap((fam) =>
        [...selected].filter((cat) => !keysOf(lng).has(`${fam}_${cat}`)).map((cat) => `${fam}_${cat}`),
      )
      expect(problems, `${lng} lacks plural forms its language selects`).toEqual([])
    })
  })

  // Same keys is not enough: an interpolation slot dropped or misspelled in a
  // translation renders as literal "{{name}}" (or loses the value) only in
  // that language, which no English-side test would ever see.
  describe('placeholder parity with en', () => {
    const slotsOf = (value: unknown): string[] =>
      typeof value === 'string' ? (value.match(/\{\{\s*[^}]+?\s*\}\}/g) ?? []).map((s) => s.replace(/\s/g, '')).sort() : []

    it.each(TRANSLATED)('%s keeps every {{placeholder}} en uses', (lng) => {
      const en = new Map(flatten(bundles.en))
      const mismatched = flatten(bundles[lng])
        .filter(([key, value]) => !isPlural(key) && en.has(key) && slotsOf(value).join() !== slotsOf(en.get(key)).join())
        .map(([key, value]) => `  ${key}: [${slotsOf(en.get(key))}] became [${slotsOf(value)}]`)
      expect(mismatched, `${lng} placeholder mismatches:\n${mismatched.join('\n')}`).toEqual([])
    })

    // A plural form is checked against its whole en family, since Polish
    // `_few` has no en counterpart of its own. {{count}} is the one slot whose
    // presence depends on the language: a form may spell the number out
    // ("został 1") only if its category is selected by exactly one count.
    // That holds for German or Polish `_one`, but Ukrainian `_one` also covers
    // 21, 31, 101…, so a literal "1" there would tell someone with 21 left
    // that they have 1. Nothing may be invented.
    //
    // Counts start at 1: every plural call site renders only for a positive
    // count (completionsLabel routes 0 to its own key, the rest are guarded),
    // so French `_one` selecting {0, 1} does not make its "1 restante" wrong.
    // A form no such count selects (Chinese `_one`) is never read, so it is
    // held only to inventing nothing.
    it.each(TRANSLATED)('%s keeps every {{placeholder}} of each plural family', (lng) => {
      const en = new Map(flatten(bundles.en))
      const familySlots = (fam: string) =>
        [...new Set([...en].filter(([k]) => isPlural(k) && family(k) === fam).flatMap(([, v]) => slotsOf(v)))].sort()
      const noCount = (slots: string[]) => slots.filter((s) => s !== '{{count}}')
      const rules = new Intl.PluralRules(lng)
      const integersIn = new Map<string, number>()
      for (let n = 1; n <= 1000; n++) integersIn.set(rules.select(n), (integersIn.get(rules.select(n)) ?? 0) + 1)
      const mismatched = flatten(bundles[lng])
        .filter(([key]) => isPlural(key) && enFamilies().has(family(key)))
        .filter(([key, value]) => {
          const want = familySlots(family(key))
          const got = slotsOf(value)
          const countOptional = (integersIn.get(categoryOf(key)!) ?? 0) <= 1
          return (
            noCount(got).join() !== noCount(want).join() ||
            got.some((s) => !want.includes(s)) ||
            (want.includes('{{count}}') && !countOptional && !got.includes('{{count}}'))
          )
        })
        .map(([key, value]) => `  ${key}: [${familySlots(family(key))}] became [${slotsOf(value)}]`)
      expect(mismatched, `${lng} placeholder mismatches:\n${mismatched.join('\n')}`).toEqual([])
    })
  })

  // pt-BR is generated from pt-PT by scripts/gen-pt-br.mjs — never edited by
  // hand. Regenerate to a scratch path and diff against the committed file, so
  // a pt-PT edit that was not followed by `node scripts/gen-pt-br.mjs` (or a
  // hand edit to pt-BR that regeneration would overwrite) fails here.
  it('pt-BR is exactly the transform of pt-PT', async () => {
    const { execFileSync } = await import('node:child_process')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readFileSync } = await import('node:fs')
    const out = join(tmpdir(), `pt-br-regen-${process.pid}.json`)
    execFileSync('node', ['scripts/gen-pt-br.mjs', out])
    const regenerated = JSON.parse(readFileSync(out, 'utf8'))
    expect(
      bundles['pt-BR'],
      'pt-BR does not match its transform — run `node scripts/gen-pt-br.mjs` (and never edit pt-BR by hand)',
    ).toEqual(regenerated)
  })

  // Locale-to-locale parity cannot see a code the ENGINE knows about and no
  // locale has, which is how RATE_LIMITED arrived unmapped: @glance-apps/sync
  // 1.11.0 added it, the bump to 2.0.0 brought it in, and syncErrorText's
  // fallback to the engine's own message meant it degraded to English instead
  // of failing. Nothing was broken, and nothing said anything either.
  //
  // So the codes are checked against the package's own union rather than
  // against each other. A code that should NOT have a key needs an entry in
  // UNMAPPED with a reason, which turns "we forgot" into "we decided".
  describe('every SyncErrorCode the engine can surface has English text', () => {
    // Codes deliberately without a key, and why.
    const UNMAPPED: Record<string, string> = {
      // dbSyncCycle never routes this to onError: a suppressed half is
      // reported through surfaceStandingWindow (quota only) and the standing
      // window is rendered from getBackoffState() by backoffStatus.ts, not by
      // syncErrorText. A string here would be unreachable.
      SYNC_SUPPRESSED: 'never reaches onError; rendered as a backoff window',
    }

    const codes = (() => {
      const dts = readFileSync(
        join(__dirname, '../node_modules/@glance-apps/sync/types/index.d.ts'),
        'utf8',
      )
      // Comments are stripped BEFORE the union's terminating `;` is located.
      // Several members carry doc comments containing a semicolon, so matching
      // `=([\s\S]*?);` against the raw text truncates the union mid-way — it
      // silently yielded 12 of 14 codes, with the two newest (the ones a bump
      // actually adds) falling off the end.
      const body = dts.slice(dts.indexOf('export type SyncErrorCode =')).replace(/\/\/[^\n]*/g, '')
      const union = body.slice(0, body.indexOf(';'))
      return [...union.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1])
    })()

    it('parses the whole union out of the package types', () => {
      // Pinned at BOTH ends: a parse that stops early still returns plausible
      // codes, so a count threshold does not catch it. The last member is the
      // one that matters — a truncated union makes every case below vacuous
      // for exactly the newly-added codes this guard exists to catch.
      expect(codes[0]).toBe('APP_ID_MISMATCH')
      expect(codes).toContain('NETWORK_ERROR')
      expect(codes[codes.length - 1]).toBe('SYNC_SUPPRESSED')
    })

    it.each(codes)('%s', (code) => {
      const errors = (bundles.en as { sync: { errors: Record<string, string> } }).sync.errors
      if (code in UNMAPPED) {
        expect(
          errors[code],
          `${code} is listed in UNMAPPED (${UNMAPPED[code]}) but has a string. ` +
            'Drop it from UNMAPPED if it can now reach onError.',
        ).toBeUndefined()
        return
      }
      expect(
        errors[code],
        `sync.errors.${code} is missing from en. The engine can pass this code to ` +
          'onError, and syncErrorText falls back to the raw English message, so the ' +
          'gap shows up as untranslated text rather than as an error. Add the key to ' +
          'every locale (pt-BR via scripts/gen-pt-br.mjs), or add it to UNMAPPED here ' +
          'with the reason it cannot be surfaced.',
      ).toBeTypeOf('string')
    })
  })

  /**
   * Keys that ship in English in some languages until a translation lands, and
   * which languages are waiting. The parity checks above are satisfied by the
   * English text, so without this list nothing in the repo would say these are
   * untranslated. The point of the list is that it shrinks: each entry must
   * name exactly the languages that still carry en's text, so translating one
   * fails here until the language is dropped, and an empty entry is removed.
   * Same shape as dayGLANCE's UNTRANSLATED.
   */
  describe('UNTRANSLATED: English on the way to a translation', () => {
    const UNTRANSLATED: Record<string, string[]> = {
      // The paywall's two pending outcomes (billing Phase 2) shipped in English
      // first, so no installable version reaches one with nothing to show; the
      // localization pass translates them.
      'paywall.purchasePendingApproval': ['de', 'es', 'fr', 'it', 'ja', 'pl', 'pt-BR', 'pt-PT', 'uk', 'zh-CN'],
      'paywall.purchaseUnconfirmed': ['de', 'es', 'fr', 'it', 'ja', 'pl', 'pt-BR', 'pt-PT', 'uk', 'zh-CN'],
    }
    const get = (lng: string, key: string): unknown =>
      key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], bundles[lng])

    it.each(Object.keys(UNTRANSLATED))('%s names exactly the languages still in English', (key) => {
      expect(get('en', key), `${key} is not in en; drop it from UNTRANSLATED`).toBeTypeOf('string')
      const stillEnglish = TRANSLATED.filter((lng) => get(lng, key) === get('en', key)).sort()
      expect(
        stillEnglish,
        `UNTRANSLATED['${key}'] must list exactly the languages that still carry en's text. ` +
          'A language translated since is dropped from the list (and the key, once its list is empty); ' +
          'a language listed that does not ship is a typo.',
      ).toEqual([...UNTRANSLATED[key]].sort())
      expect(UNTRANSLATED[key].length, `${key} is translated everywhere; drop it from UNTRANSLATED`).toBeGreaterThan(0)
    })
  })

  /**
   * Every t('literal') in the source must resolve in en. Before this, a key
   * that existed only as a `defaultValue` in the code never reached a bundle,
   * so every check in this file passed while every language rendered English
   * (the paywall's pending strings, until #472). Ported from dayGLANCE's
   * "defines every literal translation key used by source", with one
   * difference: a key may resolve to an object as well as a string, since
   * `t('menu', { returnObjects: true })` reads a whole block on purpose.
   *
   * KNOWN BLIND SPOT: a key built at run time, t(`people.dateKind.${kind}`),
   * is not a literal and is not checked. There were 19 such calls when this
   * was written (about 2% of t() calls), here and in dayGLANCE alike. This
   * check is not total; a template-built key that misses falls back to the
   * key itself on screen.
   *
   * NOT CHECKED, ON PURPOSE: whether a key that resolves to an object is
   * called with `returnObjects: true`. This check's job is keys with no bundle
   * entry, not misuse of keys that have one, and a plain t('menu') fails
   * visibly (i18next puts its "returned an object" text on screen) rather
   * than silently shipping English. Reading each call's options would also
   * need a parser, not this regex.
   */
  describe('every literal t() key in the source resolves in en', () => {
    const LITERAL_CALL = /\bt\(\s*['"]([^'"]+)['"]/g

    // Every path en resolves: each string, and each object above them.
    const resolvable = (obj: Record<string, unknown>, prefix = ''): string[] =>
      Object.entries(obj).flatMap(([k, v]) => {
        const key = prefix ? `${prefix}.${k}` : k
        return v && typeof v === 'object' && !Array.isArray(v)
          ? [key, ...resolvable(v as Record<string, unknown>, key)]
          : [key]
      })

    // The literal keys in one file that en cannot resolve. A plural family is
    // called by its base name (t('x', { count })), so x_one or x_other covers x.
    const unresolvedIn = (source: string, keys: Set<string>) =>
      [...source.matchAll(LITERAL_CALL)]
        .map((m) => m[1])
        .filter((key) => !keys.has(key) && !keys.has(`${key}_one`) && !keys.has(`${key}_other`))

    const sourceFiles = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
        const path = join(dir, d.name)
        if (d.isDirectory()) return sourceFiles(path)
        return /\.(ts|tsx|js|jsx)$/.test(d.name) && !d.name.includes('.test.') && !d.name.endsWith('.d.ts') ? [path] : []
      })

    it('finds the source it scans', () => {
      // Guards the walk: a broken one finds nothing and passes below.
      const calls = sourceFiles(__dirname).reduce((n, f) => n + [...readFileSync(f, 'utf8').matchAll(LITERAL_CALL)].length, 0)
      expect(calls).toBeGreaterThan(500)
    })

    it('has an en entry for every literal key', () => {
      const keys = new Set(resolvable(bundles.en))
      const missing = sourceFiles(__dirname).flatMap((f) =>
        unresolvedIn(readFileSync(f, 'utf8'), keys).map((key) => `${key}: ${relative(join(__dirname, '..'), f)}`),
      )
      expect(
        missing,
        'Every literal t() key needs a bundle entry (in every language: the coverage checks above enforce that). ' +
          'A defaultValue alone ships English to every language and no check here sees it.',
      ).toEqual([])
    })

    describe('controls', () => {
      const keys = new Set(resolvable({ menu: { file: 'File' }, done: 'Done', item_one: '1 item', item_other: 'items' }))

      it('fails a key with no en entry, defaultValue or not', () => {
        expect(unresolvedIn(`t('gone'); t("also.gone", { defaultValue: 'Gone' })`, keys)).toEqual(['gone', 'also.gone'])
      })

      it('accepts a string, a plural family by its base name, and a whole object', () => {
        expect(unresolvedIn(`t('done'); t('item', { count }); i18n.t('menu', { returnObjects: true }); t('menu.file')`, keys)).toEqual([])
      })

      it('fails a path below a string, or a missing child of an object', () => {
        expect(unresolvedIn(`t('done.more'); t('menu.edit')`, keys)).toEqual(['done.more', 'menu.edit'])
      })

      it('cannot see a key built at run time (the blind spot above)', () => {
        expect(unresolvedIn('t(`menu.${name}`)', keys)).toEqual([])
      })
    })
  })

  // Parity can be satisfied by pasting the English text in. Spot-check one
  // string from each of the two backlog sections for actual translation.
  describe('backlog keys are actually translated', () => {
    const SAMPLES = ['backup.areYouSureBody', 'integration.vaultIntentsNoConnection']
    const get = (lng: string, key: string): unknown =>
      key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], bundles[lng])

    it.each(TRANSLATED.flatMap((lng) => SAMPLES.map((key) => [lng, key])))(
      '%s translates %s',
      (lng, key) => {
        expect(get(lng, key), `${lng} is missing ${key}`).toBeTypeOf('string')
        expect(get(lng, key), `${lng} left ${key} in English`).not.toBe(get('en', key))
      },
    )
  })
})
