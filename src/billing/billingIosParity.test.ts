import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { BILLING_CODE_PENDING, BILLING_CODE_UNCONFIRMED } from '@glance-apps/billing'
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

  it('under -GlanceBillingStartLocked, holds back only the initial reads and the pushes before a person acts', () => {
    // The whole point of that override: the app opens locked, and then every
    // real path runs. A branch on it inside purchase, refresh, prices or
    // eligibility would mean a Restore that "worked" without RevenueCat having
    // said so. Since 0.2.4 it reaches exactly one more place, by design: the
    // 'billingStatus' push (RevenueCat's delegate) is held until the first read
    // a person caused, or the delegate reporting the device's entitlement at
    // launch would unlock the app with no Restore tap and the test would pass
    // proving nothing.
    const touching = functionsOf(swift)
      .filter((f) => /\bstartLocked\b|GlanceBillingStartLocked/.test(f.body))
      .map((f) => f.name)
    expect(touching.sort()).toEqual(['getStatus', 'pushActiveEntitlement'])

    // And the suppression is bounded: a counter the reads run out of, not a
    // flag that holds the app locked for the life of the process.
    const debug = partition(swift).debugOnly
    expect(debug).toContain('startLockedReads < Self.startLockedSuppressedReads')
    expect(debug).toContain('startLockedReads += 1')
    expect(swift).toMatch(/startLockedSuppressedReads = 2\b/)
  })

  it('holds the push until the first read a person caused, and only then', () => {
    const push = functionsOf(swift).find((f) => f.name === 'pushActiveEntitlement')!
    // The hold is DEBUG-only and sits ahead of the send.
    const { debugOnly, inRelease } = partition(push.body)
    expect(debugOnly).toContain('if startLocked, !startLockedPersonRead { return }')
    expect(inRelease).not.toMatch(/startLocked/)
    expect(push.body.indexOf('!startLockedPersonRead')).toBeLessThan(push.body.indexOf('notifyListeners'))
    // Released by the real read, the third, and by nothing else.
    const getStatus = functionsOf(swift).find((f) => f.name === 'getStatus')!.body
    const realBranch = getStatus.slice(getStatus.indexOf('} else if startLocked ||'))
    expect(realBranch).toContain('if startLocked { startLockedPersonRead = true }')
    expect(swift.replace(/\/\/.*$/gm, '').match(/startLockedPersonRead = true/g)?.length).toBe(1)
  })
})

/**
 * Top-level functions of a Swift source, by name with their bodies (comments
 * stripped, braces matched). Enough for these sources: no braces in strings.
 */
function functionsOf(src: string): { name: string; body: string }[] {
  const code = src.replace(/\/\/.*$/gm, '')
  const out: { name: string; body: string }[] = []
  const re = /\bfunc (\w+)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    const open = code.indexOf('{', m.index)
    let depth = 0
    let i = open
    for (; i < code.length; i++) {
      if (code[i] === '{') depth++
      else if (code[i] === '}' && --depth === 0) break
    }
    out.push({ name: m[1], body: code.slice(open, i + 1) })
  }
  return out
}

// @glance-apps/billing 0.2.4's opt-in native contract, as the iOS plugin keeps
// it. The Swift is not compiled in CI, so these read the source; the package's
// own tests cover what the adapter does with each half.
describe('iOS billing: the 0.2.4 native contract', () => {
  const fn = (src: string, name: string) => {
    const f = functionsOf(src).find((x) => x.name === name)
    if (!f) throw new Error(`no func ${name}`)
    return f.body
  }
  const code = (src: string) => src.replace(/\/\/.*$/gm, '')

  it('tells the adapter refresh() reports completion, and keeps that promise', () => {
    expect(fn(swift, 'initialize')).toContain('call.resolve(["refreshReportsCompletion": true])')
    // The plugin resolves only after the store work has been awaited.
    const refresh = fn(swift, 'refresh')
    expect(refresh).toMatch(/await billing\.refresh\(\)\s*\n\s*call\.resolve\(\)/)
    expect(refresh.match(/call\.resolve/g)?.length).toBe(1)
    // And the store's refresh returns only when the re-read and sync are done.
    const coreRefresh = fn(core, 'refresh')
    expect(coreRefresh).toMatch(/func refresh\(\) async|await inFlightRefresh\(\)\.value/)
    expect(coreRefresh).toContain('await inFlightRefresh().value')
  })

  it('an overlapping refresh joins the one in flight instead of returning early', () => {
    const inFlight = fn(core, 'inFlightRefresh')
    expect(inFlight).toContain('if let task = refreshTask { return task }')
    expect(inFlight).toContain('refreshTask = task')
    // The old guard skipped the second sync and let its caller read too soon.
    expect(code(core)).not.toMatch(/syncInFlight|beginSync|endSync/)
  })

  it("is RevenueCat's delegate, set when Purchases is configured, without touching the configure call", () => {
    const configure = fn(core, 'configure')
    expect(configure.indexOf('Purchases.shared.delegate = self'))
      .toBeGreaterThan(configure.indexOf('Purchases.configure(withAPIKey: apiKey)'))
    expect(core).toMatch(/final class RevenueCatBilling: NSObject, PurchasesDelegate\b/)
    expect(read('ios/App/App/AppDelegate.swift')).toMatch(/RevenueCatBilling\.shared\.configure\(apiKey: "appl_\w+"\)/)
  })

  it('passes on ACTIVE entitlements only, and the push has no inactive form', () => {
    const delegate = fn(core, 'purchases')
    expect(delegate).toMatch(/guard let ent = customerInfo\.entitlements\[Self\.entitlementId\], ent\.isActive else \{ return \}/)
    expect(delegate.indexOf('ent.isActive')).toBeLessThan(delegate.indexOf('onActiveEntitlement'))
    // One send site, and `active` is the literal true there.
    const sends = code(swift).match(/notifyListeners\("billingStatus"/g) ?? []
    expect(sends.length).toBe(1)
    const push = fn(swift, 'pushActiveEntitlement')
    expect(push).toContain('"active": true,')
    expect(push).not.toMatch(/"active":\s*(?!true\b)\w/)
  })

  it("emits 'success' only when the returned entitlement includes ours; otherwise pending/unconfirmed", () => {
    const purchase = fn(core, 'purchase')
    const success = purchase.indexOf('emit(status: "success"')
    const check = purchase.indexOf('result.customerInfo.entitlements[Self.entitlementId]?.isActive == true')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(success)
    expect(purchase).toContain('emit(status: "pending", code: Self.codeUnconfirmed')
    expect(purchase.match(/emit\(status: "success"/g)?.length).toBe(1)
  })

  it('reports a deferred payment as pending, not as an error', () => {
    const emitError = fn(core, 'emitError')
    const pending = emitError.indexOf('if rcError == .paymentPendingError')
    expect(pending).toBeGreaterThan(-1)
    expect(emitError.slice(pending)).toMatch(/emit\(status: "pending", code: Self\.codePending[^)]*\)\s*\n\s*return/)
  })

  it("status reads see everything the delegate has seen: the cache, else the delegate's copy (EntitlementRead)", () => {
    expect(fn(core, 'status')).toContain('let ent = currentCustomerInfo()?.entitlements[Self.entitlementId]')
    expect(fn(core, 'status')).not.toContain('cachedCustomerInfo')
    const current = fn(core, 'currentCustomerInfo')
    expect(current).toContain('let cached = Purchases.shared.cachedCustomerInfo')
    expect(current).toContain('let reported = lastReported')
    // The rule itself, and its behavioural tests, are the package's.
    expect(current).toContain('return EntitlementRead.newest(cached: cached, reported: reported)')
    expect(core).toMatch(/^import EntitlementRead$/m)
    // No date comparison: the two copies' requestDates come from different clocks.
    expect(code(core)).not.toContain('requestDate')
    // The delegate records every report, whatever it says, before its active-only guard.
    const delegate = fn(core, 'purchases')
    const record = delegate.indexOf('lastReported = customerInfo')
    expect(record).toBeGreaterThan(-1)
    expect(record).toBeLessThan(delegate.indexOf('guard let ent'))
  })

  it("uses the package's pending codes", () => {
    expect(core).toContain(`static let codePending = ${BILLING_CODE_PENDING}`)
    expect(core).toContain(`static let codeUnconfirmed = ${BILLING_CODE_UNCONFIRMED}`)
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
// target is the document, and each string is its key plus en's text.
vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom')>()),
  createPortal: (node: unknown) => node,
}))
vi.mock('react-i18next', async () => {
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const en = JSON.parse(readFileSync(resolve(__dirname, '../../public/locales/en/translation.json'), 'utf8'))
  const text = (key: string) => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en)
  return {
    useTranslation: () => ({
      // The key, plus en's text when the bundle has it, so a test can read the
      // copy the user sees.
      t: (key: string) => (typeof text(key) === 'string' ? `${key}|${text(key)}` : key),
    }),
  }
})
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
  async function renderPaywall(p: string, channel?: string, billingEvent: unknown = null) {
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
      billingEvent,
      billingErrorMessage: () => 'error text',
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

  it('says something for every pending outcome: approval awaited, or payment being confirmed', async () => {
    const deferred = (await renderPaywall('ios', undefined,
      { status: 'pending', code: BILLING_CODE_PENDING, message: 'deferred', productId: 'p', ts: 1 })).html
    expect(deferred).toContain('paywall.purchasePendingApproval|Your purchase is waiting for approval.')

    const unconfirmed = (await renderPaywall('ios', undefined,
      { status: 'pending', code: BILLING_CODE_UNCONFIRMED, message: 'unconfirmed', productId: 'p', ts: 1 })).html
    expect(unconfirmed).toContain('paywall.purchaseUnconfirmed|Your purchase went through')
    // Unconfirmed points at waiting or support, never at Restore, which would
    // find nothing yet and say so.
    expect(unconfirmed).toContain('support@glance-apps.com')
    for (const html of [deferred, unconfirmed]) {
      const message = html.slice(html.indexOf('role="status"'))
      expect(message.slice(0, message.indexOf('</p>'))).not.toMatch(/restore/i)
    }

    // Nothing extra for no event, or for an error (which has its own line).
    expect((await renderPaywall('ios')).html).not.toContain('role="status"')
    expect((await renderPaywall('ios', undefined,
      { status: 'error', code: 6, message: 'x', productId: 'p', ts: 1 })).html).not.toContain('role="status"')
  })

  it('keeps Reviewer access on both platforms, since App Review needs it past the gate', async () => {
    for (const [p, channel] of [['ios'], ['android', 'play']]) {
      expect((await renderPaywall(p, channel)).html).toContain('paywall.reviewerAccess')
    }
  })
})

// EntitlementRead: the read rule, as a package (ios/App/Packages/EntitlementRead).
describe('EntitlementRead', () => {
  const PKG = 'ios/App/Packages/EntitlementRead'
  const FILES = [
    'Package.swift',
    'Sources/EntitlementRead/EntitlementRead.swift',
    'Tests/EntitlementReadTests/EntitlementReadTests.swift',
  ]

  // Three byte-identical copies: dayGLANCE, lastGLANCE and lifeGLANCE. Each
  // repo holds its copy to this one fingerprint, the same value in all three,
  // so a change to one copy fails here until the other two match. Change all
  // three together, then the value in all three.
  const FINGERPRINT = '2b8744180996179a24dfc2a46733acb97cdda7361c7fcc1e42202e05f019d93b'

  it('is the shared copy, byte for byte', () => {
    const hash = createHash('sha256')
    for (const f of FILES) hash.update(readFileSync(resolve(root, PKG, f)))
    expect(readdirSync(resolve(root, PKG, 'Sources/EntitlementRead'))).toEqual(['EntitlementRead.swift'])
    expect(readdirSync(resolve(root, PKG, 'Tests/EntitlementReadTests'))).toEqual(['EntitlementReadTests.swift'])
    expect(hash.digest('hex')).toBe(FINGERPRINT)
  })

  it('is linked into the App target, and CI runs its tests', () => {
    const pbx = read('ios/App/App.xcodeproj/project.pbxproj')
    expect(pbx).toMatch(/isa = XCLocalSwiftPackageReference;\s*relativePath = Packages\/EntitlementRead;/)
    expect(pbx).toMatch(/isa = XCSwiftPackageProductDependency;\s*package = \w+ \/\* XCLocalSwiftPackageReference "Packages\/EntitlementRead" \*\/;\s*productName = EntitlementRead;/)
    expect(pbx).toMatch(/EntitlementRead in Frameworks \*\/ = \{isa = PBXBuildFile; productRef = \w+ \/\* EntitlementRead \*\/; \};/)
    expect(read('.github/workflows/ios.yml')).toContain(`run: swift test --package-path ${PKG}`)
  })
})
