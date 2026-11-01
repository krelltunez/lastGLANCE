import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The iOS shell is not compiled in CI, so this holds BillingBridgePlugin.swift
// to the CapacitorBillingPlugin contract src/billing/billing.ts drives, and to
// the registration and Xcode project that make the plugin exist at all. An
// unregistered plugin still compiles; the failure mode is an iOS app whose
// adapter talks to nothing, so the gate below fails closed with no store.

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')
const swift = read('ios/App/App/plugins/BillingBridgePlugin.swift')
const core = read('ios/App/App/plugins/RevenueCatBilling.swift')
const ts = read('src/billing/billing.ts')

// The methods createCapacitorAdapter calls (CapacitorBillingPlugin in
// @glance-apps/billing/capacitor), minus the Play-only consumeTestPurchase.
const CONTRACT = ['initialize', 'getStatus', 'refresh', 'purchase', 'getProductPrices', 'getTrialEligibility']

describe('iOS BillingBridge plugin parity', () => {
  it('is registered and compiled into the app target', () => {
    expect(read('ios/App/App/BridgeViewController.swift')).toContain('registerPluginInstance(BillingBridgePlugin())')
    const pbx = read('ios/App/App.xcodeproj/project.pbxproj')
    for (const file of ['BillingBridgePlugin', 'RevenueCatBilling']) {
      expect(pbx).toMatch(new RegExp(`${file}\\.swift in Sources \\*/ = \\{isa = PBXBuildFile`))
      expect(pbx).toMatch(new RegExp(`${file}\\.swift \\*/ = \\{isa = PBXFileReference`))
      expect((pbx.match(new RegExp(`${file}\\.swift in Sources \\*/,`, 'g')) ?? []).length).toBe(1)
    }
    expect(pbx).toMatch(/RevenueCat in Frameworks \*\/ = \{isa = PBXBuildFile/)
  })

  it('answers to the name billing.ts registers', () => {
    const registered = ts.match(/registerPlugin<CapacitorBillingPlugin>\('(\w+)'\)/)?.[1]
    expect(registered).toBe('BillingBridge')
    expect(swift).toContain(`public let jsName = "${registered}"`)
  })

  it('declares and implements exactly the contract methods', () => {
    const block = swift.slice(swift.indexOf('pluginMethods'), swift.indexOf('].map'))
    const declared = [...block.matchAll(/"(\w+)"/g)].map((m) => m[1])
    expect([...declared].sort()).toEqual([...CONTRACT].sort())
    for (const m of CONTRACT) {
      expect(swift).toMatch(new RegExp(`@objc func ${m}\\(_ call: CAPPluginCall\\)`))
    }
  })

  it('emits terminal outcomes on the event the adapter subscribes to', () => {
    expect(swift).toContain('notifyListeners("billingEvent"')
  })

  it('never reports a trial for a product with no introductory offer', () => {
    // Eligibility defaults to true until the store answers, so the store's
    // "no intro offer" answer must write false, like an explicit ineligible.
    expect(core).toMatch(/case \.ineligible, \.noIntroOfferExists:\s*\n(\s*\/\/.*\n)*\s*UserDefaults\.standard\.set\(false/)
  })

  // The two Debug-only billing overrides, as launch-argument UserDefaults keys.
  // `-GlanceBillingRealStatus` reports the real entitlement from the first read;
  // `-GlanceBillingStartLocked` reports inactive for the adapter's two mount
  // reads and the real entitlement after them, so a Debug build can be opened
  // at the paywall and unlocked by a real Restore on a device that already owns
  // the subscription. Neither may exist in a Release build.
  const OVERRIDES = ['GlanceBillingRealStatus', 'GlanceBillingStartLocked']

  /**
   * Splits Swift source into the text only a DEBUG build compiles and the text
   * a Release build can reach, by walking the preprocessor nesting.
   *
   * This replaces a slice-by-first-index version, and the reason matters: that
   * one took `release` as everything between the FIRST `#else` and the FIRST
   * `#endif`. Adding a second `#if DEBUG` block to the file ahead of getStatus
   * put an `#endif` before that `#else`, which made the slice EMPTY — so
   * `expect(release).not.toContain(...)` would have passed while asserting
   * nothing at all. An unrecognised directive throws rather than being skipped,
   * for the same reason.
   */
  function partition(src: string) {
    const debugOnly: string[] = []
    const inRelease: string[] = []
    // One frame per open conditional: whether the branch now open is DEBUG-only.
    const stack: { isDebug: boolean; inDebugBranch: boolean }[] = []
    for (const raw of src.split('\n')) {
      // Prose is not code. The overrides are named in the comments above
      // getStatus, which sit outside the guard on purpose.
      const line = raw.replace(/\/\/.*$/, '')
      const t = line.trim()
      if (t.startsWith('#')) {
        if (t === '#if DEBUG') stack.push({ isDebug: true, inDebugBranch: true })
        else if (/^#if\b/.test(t)) stack.push({ isDebug: false, inDebugBranch: false })
        else if (t === '#else') {
          const top = stack[stack.length - 1]
          if (!top) throw new Error('#else with no open #if')
          top.inDebugBranch = top.isDebug ? false : top.inDebugBranch
        } else if (t === '#endif') {
          if (!stack.pop()) throw new Error('#endif with no open #if')
        } else throw new Error(`unhandled preprocessor directive: ${t}`)
        continue
      }
      ;(stack.some((f) => f.isDebug && f.inDebugBranch) ? debugOnly : inRelease).push(line)
    }
    if (stack.length > 0) throw new Error('unterminated #if')
    return { debugOnly: debugOnly.join('\n'), inRelease: inRelease.join('\n') }
  }

  it('keeps both Debug-only overrides out of Release builds', () => {
    const { debugOnly, inRelease } = partition(swift)
    // The parse found both branches of getStatus, so neither side is empty and
    // the assertions below cannot pass vacuously.
    expect(debugOnly).toContain('"active": true')
    expect(inRelease).toContain('let status = billing.status()')

    for (const key of OVERRIDES) {
      expect(debugOnly, `${key} must be read in the DEBUG branch`)
        .toContain(`UserDefaults.standard.bool(forKey: "${key}")`)
      expect(inRelease, `${key} must not be reachable in Release`).not.toContain(key)
      // Read in exactly one place, so there is no second site to drift.
      expect(swift.match(new RegExp(`forKey: "${key}"`, 'g'))?.length).toBe(1)
    }
  })

  it('fakes nothing but the initial status read under -GlanceBillingStartLocked', () => {
    // The whole point of that override: the app opens locked, and then every
    // real path runs. A branch on it inside any other method would mean a
    // Restore that "worked" without RevenueCat having said so.
    // Comments stripped first: the section comment above getStatus names the
    // override, and it trails the body of whichever method precedes it.
    const code = swift.replace(/\/\/.*$/gm, '')
    const touching = code
      .split(/@objc func /)
      .slice(1)
      .filter((b) => b.includes('GlanceBillingStartLocked'))
      .map((b) => b.slice(0, b.indexOf('(')))
    expect(touching).toEqual(['getStatus'])

    // And the suppression is bounded: a counter the reads run out of, not a
    // flag that holds the app locked for the life of the process.
    const debug = partition(swift).debugOnly
    expect(debug).toContain('startLockedReads < Self.startLockedSuppressedReads')
    expect(debug).toContain('startLockedReads += 1')
    expect(swift).toMatch(/startLockedSuppressedReads = 2\b/)
  })
})

// billing.ts reads the platform and channel at module load, so each case
// imports a fresh copy under a mocked Capacitor.
const createCapacitorAdapter = vi.fn(() => ({}))
let platform = 'web'

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => platform },
  // Like Capacitor's real plugin proxy: every property is a function.
  registerPlugin: () => new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : vi.fn(async () => ({}))) }),
}))
vi.mock('@glance-apps/billing/capacitor', () => ({ createCapacitorAdapter }))
// For rendering the real PaywallModal in this node environment: the portal
// target is the document, and the strings are their own keys.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (node: unknown) => node,
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/native/backButton', () => ({ leaveApp: vi.fn() }))

async function load(p: string, channel?: string) {
  platform = p
  if (channel) vi.stubEnv('VITE_BUILD_CHANNEL', channel)
  vi.resetModules()
  return import('./billing')
}

describe('billing gate by platform and channel', () => {
  beforeEach(() => createCapacitorAdapter.mockClear())
  afterEach(() => vi.unstubAllEnvs())

  it('gates the iOS app whatever the channel, since every iOS build is a store build', async () => {
    for (const channel of [undefined, 'web', 'github']) {
      createCapacitorAdapter.mockClear()
      await load('ios', channel)
      expect(createCapacitorAdapter).toHaveBeenCalledTimes(1)
    }
  })

  it('never gates web, PWA or self-hosted builds', async () => {
    for (const channel of [undefined, 'web', 'play']) {
      createCapacitorAdapter.mockClear()
      await load('web', channel)
      expect(createCapacitorAdapter).not.toHaveBeenCalled()
    }
  })

  it('gates Android only on the Play channel', async () => {
    await load('android', 'github')
    expect(createCapacitorAdapter).not.toHaveBeenCalled()
    await load('android', 'play')
    expect(createCapacitorAdapter).toHaveBeenCalledTimes(1)
  })

  it('hands the iOS adapter only the methods the native plugin implements', async () => {
    await load('ios')
    const [[{ plugin, products }]] = createCapacitorAdapter.mock.calls as unknown as [[{ plugin: object; products: unknown }]]
    expect(Object.keys(plugin).sort()).toEqual([...CONTRACT, 'addListener'].sort())
    expect(typeof (plugin as Record<string, unknown>).consumeTestPurchase).toBe('undefined')
    expect(products).toEqual({ yearly: 'lastglance_pro_annual', lifetime: 'lastglance_pro_lifetime' })
  })

  it('points Manage subscription and the paywall copy at the right store', async () => {
    const ios = await load('ios')
    expect(ios.MANAGE_SUBSCRIPTION_URL).toBe('https://apps.apple.com/account/subscriptions')
    expect(ios.STORE_NAME).toBe('App Store')
    const android = await load('android', 'play')
    expect(android.MANAGE_SUBSCRIPTION_URL).toContain('play.google.com/store/account/subscriptions')
    expect(android.STORE_NAME).toBe('Google Play')
  })
})

describe('paywall close control by platform', () => {
  // Rendered from the real component, so removing the platform condition in
  // PaywallModal fails here, not just a change to the constant.
  async function renderPaywall(p: string, channel?: string) {
    const { GATE_DISMISSIBLE } = await load(p, channel)
    // createPortal is stubbed above; its target argument still reads document.body.
    vi.stubGlobal('document', { body: null })
    const [{ createElement }, { renderToStaticMarkup }, { PaywallModal }] = await Promise.all([
      import('react'),
      import('react-dom/server'),
      import('@/components/PaywallModal/PaywallModal'),
    ])
    const billing = {
      prices: { yearly: null, lifetime: null },
      trialEligible: true,
      trialDays: null,
      isLoading: false,
      billingEvent: null,
    } as unknown as Parameters<typeof PaywallModal>[0]['billing']
    return { GATE_DISMISSIBLE, html: renderToStaticMarkup(createElement(PaywallModal, { billing })) }
  }

  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('renders no close control on iOS, where an app cannot close itself', async () => {
    const { GATE_DISMISSIBLE, html } = await renderPaywall('ios')
    expect(GATE_DISMISSIBLE).toBe(false)
    expect(html).not.toContain('aria-label="Close"')
  })

  it('keeps the close control on Android, where Play requires one', async () => {
    const { GATE_DISMISSIBLE, html } = await renderPaywall('android', 'play')
    expect(GATE_DISMISSIBLE).toBe(true)
    expect(html.match(/aria-label="Close"/g)?.length).toBe(1)
  })

  it('keeps Reviewer access on both platforms, since App Review needs it past the gate', async () => {
    for (const [p, channel] of [['ios'], ['android', 'play']]) {
      expect((await renderPaywall(p, channel)).html).toContain('paywall.reviewerAccess')
    }
  })
})
