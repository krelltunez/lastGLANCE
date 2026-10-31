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

  it('keeps the real-status override out of Release builds', () => {
    // The override lives only between `#if DEBUG` and `#else` in getStatus.
    const debug = swift.slice(swift.indexOf('#if DEBUG'), swift.indexOf('#else'))
    const release = swift.slice(swift.indexOf('#else'), swift.indexOf('#endif'))
    expect(debug).toContain('UserDefaults.standard.bool(forKey: "GlanceBillingRealStatus")')
    expect(release).not.toContain('GlanceBillingRealStatus')
    expect(swift.match(/GlanceBillingRealStatus"/g)?.length).toBe(1)
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
