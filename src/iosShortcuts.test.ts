import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// The router is exercised for real below, so the native bridge it calls is
// stubbed. vi.hoisted because vi.mock is lifted above ordinary declarations.
const { plugin } = vi.hoisted(() => ({
  plugin: {
    consumeDeepLink: vi.fn(async () => ({ deepLink: null as string | null })),
    consumeSharedChore: vi.fn(async () => ({ text: null as string | null })),
  },
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'ios' },
  registerPlugin: () => plugin,
}))

import { routeWidgetDeepLink } from '@/native/pendingDeepLink'

/**
 * App Shortcuts: lastGLANCE in the Shortcuts app, Spotlight and Siri
 * (ios/App/App/ChoreShortcuts.swift). CI cannot run Xcode, and three of the
 * four things that make this feature work are not checkable by a compiler:
 *
 *  1. Target membership. App Shortcuts are read out of the APP target's
 *     AppIntents metadata, so an intent the app cannot see is never offered —
 *     and one vended by BOTH targets is offered twice, with nothing to tell
 *     the two entries apart. AddChoreControl.swift documents the first half of
 *     that trap from the other side; this is the second.
 *  2. The strings. Every title, summary and dialog resolves against the app
 *     bundle's catalog at runtime. A string added to the Swift without a key
 *     in App/Localizable.xcstrings ships English to every non-English device,
 *     silently, and the same goes for a phrase missing from
 *     App/AppShortcuts.xcstrings.
 *  3. The destination, for the two intents that open the app. The token is a
 *     bare string crossing an App Group write, an AppDelegate URL mapping and
 *     a web-router branch, each spelling it out as its own literal.
 */
const IOS = join(__dirname, '../ios/App')
const PBXPROJ = join(IOS, 'App.xcodeproj/project.pbxproj')
const SHORTCUTS = join(IOS, 'App/ChoreShortcuts.swift')

const APP_TARGET = 'App'
const WIDGET_TARGET = 'GlanceWidgetsExtension'

const src = readFileSync(SHORTCUTS, 'utf8')
const pbx = readFileSync(PBXPROJ, 'utf8')

/** Map each native target to the file names in its Sources build phase. */
function sourcesByTarget(pbxText: string): Record<string, string[]> {
  const phases: Record<string, string[]> = {}
  const phaseRe = /([0-9A-F]{24}) \/\* Sources \*\/ = \{\s*isa = PBXSourcesBuildPhase;([\s\S]*?)\n\t\t\};/g
  for (const m of pbxText.matchAll(phaseRe)) {
    phases[m[1]] = [...m[2].matchAll(/\/\* (.+?) in Sources \*\//g)].map((f) => f[1])
  }

  const out: Record<string, string[]> = {}
  const targetRe = /([0-9A-F]{24}) \/\* ([A-Za-z]+) \*\/ = \{\s*isa = PBXNativeTarget;([\s\S]*?)\n\t\t\};/g
  for (const m of pbxText.matchAll(targetRe)) {
    const files: string[] = []
    for (const ph of m[3].matchAll(/([0-9A-F]{24}) \/\* Sources \*\//g)) {
      files.push(...(phases[ph[1]] ?? []))
    }
    out[m[2]] = files
  }
  return out
}

describe('iOS App Shortcuts: target membership', () => {
  const targets = sourcesByTarget(pbx)

  it('compiles ChoreShortcuts.swift into the app target', () => {
    expect(
      targets[APP_TARGET],
      'App Shortcuts are read out of the app target’s AppIntents metadata. ' +
        'A provider the app target does not compile is never discovered, and nothing ' +
        'appears in Shortcuts, Spotlight or Siri.',
    ).toContain('ChoreShortcuts.swift')
  })

  it('keeps it out of the widget extension', () => {
    expect(
      targets[WIDGET_TARGET],
      'The same intent vended by two targets shows up twice in the Shortcuts ' +
        'action list, with no way for a user to tell which is which.',
    ).not.toContain('ChoreShortcuts.swift')
  })

  // The intents read chores from the App-Group snapshot and queue completions
  // through the widgets' own store, so both files have to leave the extension
  // and become shared. This is the wiring that makes ChoreShortcuts.swift
  // compile at all, and nothing else in the repo asserts it.
  it.each(['Snapshot.swift', 'CompletionStore.swift'])('compiles %s into both targets', (file) => {
    expect(targets[APP_TARGET], `${file} must be a member of ${APP_TARGET}`).toContain(file)
    expect(targets[WIDGET_TARGET], `${file} must stay a member of ${WIDGET_TARGET}`).toContain(file)
  })

  // CompletionStore stamps a completion with it, and ChoreLastDoneIntent reads
  // one back, so it cannot live in the widget-only file it started in.
  it('declares isoMillisFormatter in a file both targets compile', () => {
    expect(readFileSync(join(IOS, 'GlanceWidgets/Snapshot.swift'), 'utf8')).toMatch(
      /let isoMillisFormatter: DateFormatter/,
    )
    expect(readFileSync(join(IOS, 'GlanceWidgets/ChoreSnapshot.swift'), 'utf8')).not.toMatch(
      /let isoMillisFormatter: DateFormatter/,
    )
  })
})

describe('iOS App Shortcuts: what is offered', () => {
  it('declares the chore entity and a string query behind it', () => {
    expect(src).toMatch(/struct ChoreEntity: AppEntity/)
    // EntityStringQuery, not EntityQuery: the string half is what lets Siri
    // match a spoken chore name against the snapshot.
    expect(src).toMatch(/struct ChoreEntityQuery: EntityStringQuery/)
  })

  it.each([
    'MarkChoreDoneIntent',
    'ChoreLastDoneIntent',
    'AddChoreShortcutIntent',
    'ShowSoonChoresIntent',
  ])('declares %s', (name) => {
    expect(src).toMatch(new RegExp(`struct ${name}: AppIntent`))
  })

  it('offers all four from the AppShortcutsProvider', () => {
    const provider = src.slice(src.indexOf('struct LastGlanceShortcuts'))
    expect(provider).toMatch(/AppShortcutsProvider/)
    for (const name of [
      'MarkChoreDoneIntent',
      'ChoreLastDoneIntent',
      'AddChoreShortcutIntent',
      'ShowSoonChoresIntent',
    ]) {
      expect(provider, `${name} is declared but never offered`).toContain(`intent: ${name}()`)
    }
  })

  // The two that log and answer must not open the app: an automation running
  // unattended cannot clear a foregrounded app, and a completion that needed
  // the UI would be no better than tapping Done.
  it.each(['MarkChoreDoneIntent', 'ChoreLastDoneIntent'])('runs %s without opening the app', (name) => {
    const body = src.slice(src.indexOf(`struct ${name}: AppIntent`))
    expect(body.slice(0, body.indexOf('func perform'))).toMatch(/static let openAppWhenRun = false/)
  })

  // The widget Done button's intent and the Control Center control's intent do
  // the same two jobs as MarkChoreDoneIntent and AddChoreShortcutIntent. They
  // live in files the widget extension compiles, so if either became
  // discoverable the Shortcuts list would carry that action twice.
  it.each([
    ['GlanceWidgets/CompleteChoreIntent.swift', 'CompleteChoreIntent'],
    ['App/Shared/AddChoreControl.swift', 'OpenAddChoreIntent'],
  ])('keeps %s out of the Shortcuts action list', (file, name) => {
    const body = readFileSync(join(IOS, file), 'utf8')
    expect(body, `${name} must stay isDiscoverable = false`).toMatch(/static let isDiscoverable = false/)
  })
})

// ── Strings ──────────────────────────────────────────────────────────────────

interface Catalog {
  sourceLanguage: string
  strings: Record<
    string,
    { localizations?: Record<string, { stringUnit: { value: string } }>; shouldTranslate?: boolean }
  >
}

const catalog = (rel: string): Catalog => JSON.parse(readFileSync(join(IOS, rel), 'utf8'))

// The nine the app ships beyond English, as the project spells them (zh-CN,
// matching knownRegions and the other catalogs, not Info.plist's zh-Hans).
const LANGS = ['de', 'es', 'fr', 'it', 'pl', 'pt-BR', 'pt-PT', 'uk', 'zh-CN']

describe('iOS App Shortcuts: strings', () => {
  // The app target had no catalog at all until the Shortcuts arrived, so
  // turning on SWIFT_EMIT_LOC_STRINGS for it put every localized string in
  // every file it compiles into App/Localizable.xcstrings — not only this
  // file's. AddChoreControl.swift and Snapshot.swift are both app-target
  // members and both carry strings. So the scope here is the target, read out
  // of the project file, rather than a list of files to forget to update.
  const swiftByName = new Map<string, string>()
  for (const dir of ['App', 'App/plugins', 'App/Shared', 'GlanceWidgets']) {
    for (const name of readdirSync(join(IOS, dir))) {
      if (name.endsWith('.swift') && !swiftByName.has(name)) swiftByName.set(name, join(IOS, dir, name))
    }
  }
  const appSources = sourcesByTarget(pbx)[APP_TARGET]
    .filter((f) => f.endsWith('.swift'))
    .map((f) => swiftByName.get(f))
    .filter((p): p is string => Boolean(p))
    .map((p) => readFileSync(p, 'utf8'))

  // Every user-visible literal, by the construct it sits in. The catalog key
  // is the literal with each Swift interpolation replaced by %@, which is what
  // the compiler extracts.
  const PATTERNS = [
    /static let title: LocalizedStringResource = "([^"]*)"/g,
    /IntentDescription\("([^"]*)"\)/g,
    /Summary\("([^"]*)"\)/g,
    /@Parameter\(title: "([^"]*)"\)/g,
    /TypeDisplayRepresentation\(name: "([^"]*)"\)/g,
    /DisplayRepresentation\(title: "([^"]*)"\)/g,
    /shortTitle: "([^"]*)"/g,
    /dialog: "([^"]*)"/g,
    /LocalizedStringResource\("([^"]*)"\)/g,
    /String\(localized: "([^"]*)"\)/g,
    /Label\("([^"]*)", systemImage/g,
    /\.displayName\("([^"]*)"\)/g,
    /\.description\("([^"]*)"\)/g,
  ]

  const keys = new Set<string>()
  for (const file of appSources) {
    for (const re of PATTERNS) {
      for (const m of file.matchAll(re)) keys.add(m[1].replace(/\\\([^)]*\)/g, '%@'))
    }
  }

  const appCatalog = catalog('App/Localizable.xcstrings')

  it('found the strings to check', () => {
    // A rewrite that moved every literal into a construct this test does not
    // know would otherwise pass by checking nothing at all.
    expect(appSources.length).toBeGreaterThan(5)
    expect(keys.size).toBeGreaterThanOrEqual(17)
  })

  it('has a catalog key for every string the app target compiles', () => {
    // A key Xcode extracts and does not find is a key Xcode adds, which shows
    // up as a dirty catalog after someone else's unrelated build.
    const missing = [...keys].filter((k) => !(k in appCatalog.strings))
    expect(missing).toEqual([])
  })

  it('translates every key that is not a bare format specifier', () => {
    const untranslated = [...keys].filter(
      (k) => appCatalog.strings[k].shouldTranslate !== false && !appCatalog.strings[k].localizations,
    )
    expect(untranslated, 'these would ship English to every non-English device').toEqual([])
  })

  it('carries no catalog key the app target no longer compiles', () => {
    const stale = Object.keys(appCatalog.strings).filter((k) => !keys.has(k))
    expect(stale).toEqual([])
  })

  // Siri drops a phrase with no app name in it, without a word of complaint.
  const phrases = [...src.matchAll(/^\s*"([^"]*\\\(\.applicationName\)[^"]*)",?$/gm)].map((m) => m[1])

  it('found the phrases to check', () => {
    expect(phrases.length).toBe(8)
  })

  it('names the app in every phrase', () => {
    const anyLiteral = [...src.matchAll(/^\s{16}"([^"]*)",?$/gm)].map((m) => m[1])
    const nameless = anyLiteral.filter((p) => !p.includes('\\(.applicationName)'))
    expect(nameless, 'iOS silently discards a phrase that does not name the app').toEqual([])
  })

  // Phrases live in <lang>.lproj/AppShortcuts.strings, NOT in a String
  // Catalog. appshortcutstringsprocessor rejects AppShortcuts.xcstrings
  // outright whenever the app target deploys below iOS 17, and this one stays
  // at 15.0 so phones that cannot run the widgets can still run the app. That
  // rejection is a build failure, which is how the format was settled.
  const PHRASE_LANGS = ['en', ...LANGS]

  it.each(PHRASE_LANGS)('translates every phrase into %s', (lng) => {
    const file = readFileSync(join(IOS, `App/${lng}.lproj/AppShortcuts.strings`), 'utf8')
    // The key is the phrase with ${applicationName} where the Swift
    // interpolates it; en maps each key to itself.
    const missing = phrases
      .map((p) => p.replace('\\(.applicationName)', '${applicationName}'))
      .filter((key) => !file.includes(`"${key}" = "`))
    expect(missing, `these phrases would stay English on ${lng} devices`).toEqual([])
  })

  it.each(PHRASE_LANGS)('keeps the app name in the %s phrases', (lng) => {
    const file = readFileSync(join(IOS, `App/${lng}.lproj/AppShortcuts.strings`), 'utf8')
    const values = [...file.matchAll(/^"[^"]*" = "([^"]*)";$/gm)].map((m) => m[1])
    expect(values.length).toBe(phrases.length)
    expect(
      values.filter((v) => !v.includes('${applicationName}')),
      'iOS silently discards a phrase that does not name the app, translated or not',
    ).toEqual([])
  })

  it('registers the variant group so every language reaches the bundle', () => {
    // A .strings file on disk that the project does not carry is a phrase that
    // silently stays English, and nothing else here would catch it.
    const variant = pbx.slice(pbx.indexOf('EE0000000000000000000020 /* AppShortcuts.strings */ = {'))
    const group = variant.slice(0, variant.indexOf('};'))
    expect(group).toMatch(/isa = PBXVariantGroup;/)
    for (const lng of PHRASE_LANGS) expect(group, `${lng} missing from the variant group`).toContain(`/* ${lng} */`)
    expect(pbx).toContain('AppShortcuts.strings in Resources */,')
  })
})

// ── The destination, for the two intents that open the app ───────────────────

describe('iOS App Shortcuts: destinations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    plugin.consumeDeepLink.mockResolvedValue({ deepLink: null })
    plugin.consumeSharedChore.mockResolvedValue({ text: null })
  })

  // Read the token out of each intent's own body, so the chain below is
  // followed with the real value rather than a literal retyped in a test.
  const intent = (name: string) => {
    const start = src.indexOf(`struct ${name}: AppIntent`)
    const body = src.slice(start, src.indexOf('\n}\n', start))
    return { token: body.match(/writePendingDeepLink\("([^"]+)"\)/)?.[1] }
  }

  const CASES = [
    ['AddChoreShortcutIntent', 'action:add', 'lg:new-chore'],
    ['ShowSoonChoresIntent', 'filter:soon', 'lg:widget-filter-soon'],
  ] as const

  it.each(CASES)('%s writes the pending token itself', (name, token) => {
    expect(
      intent(name).token,
      '`openAppWhenRun` foregrounds the app carrying no destination of its own, so this ' +
        'write is the whole of the destination. Without it the shortcut opens the app on ' +
        'the chore list.',
    ).toBe(token)
  })

  // AddChoreControl.swift chains an OpenURLIntent as a second carrier for the
  // destination. These cannot: OpenURLIntent is iOS 18+ and this file is gated
  // at 17, so adding one back breaks the build for every device between the
  // two. That is a compile error rather than a test failure, but it is a
  // compile error CI finds and a local build of a newer deployment target may
  // not, so it is worth naming here.
  it('chains no OpenURLIntent, which would not compile at the 17.0 floor', () => {
    // The call form, not the bare name: the comment above those two intents
    // names OpenURLIntent to explain its absence, and should go on doing so.
    expect(src).not.toMatch(/OpenURLIntent\(/)
    expect(src).toMatch(/@available\(iOS 17\.0, \*\)/)
  })

  it.each(CASES)('%s routes its token to the right web event', async (name, _token, event) => {
    const dispatched: string[] = []
    vi.stubGlobal('window', { dispatchEvent: (e: Event) => { dispatched.push(e.type); return true } })
    plugin.consumeDeepLink.mockResolvedValue({ deepLink: intent(name).token! })

    await routeWidgetDeepLink()

    expect(dispatched).toContain(event)
    vi.unstubAllGlobals()
  })
})
