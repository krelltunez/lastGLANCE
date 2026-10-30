import { Capacitor, registerPlugin } from '@capacitor/core'
import { DEFAULT_STORAGE_KEYS, appleManageSubscriptionUrl, playManageSubscriptionUrl } from '@glance-apps/billing'
import { createCapacitorAdapter, type CapacitorBillingPlugin } from '@glance-apps/billing/capacitor'
import { useBilling, type UseBillingResult } from '@glance-apps/billing/react'
import { REVIEWER_SECRET } from '@/config/reviewerAccess'

// Store product ids, identical on both stores. Following the GLANCE family
// convention (dayGLANCE uses dayglance_pro_*): the subscription product
// `lastglance_pro_annual` (Play: base plan `annual`, queried as SUBS) and the
// one-time product `lastglance_pro_lifetime` (Play INAPP, App Store
// non-consumable). Permanent once created. Single source of truth for the app
// — the gate UI and both native plugins (via initialize) derive from here.
export const PRODUCT_IDS = { yearly: 'lastglance_pro_annual', lifetime: 'lastglance_pro_lifetime' }

const PLATFORM = Capacitor.getPlatform()

// Channel gating is structural (@glance-apps/billing README rule 10): only the
// store builds construct an adapter. The GitHub sideload APK and self-hosted
// web/PWA builds pass adapter: null and are ungated by design — no debug flags,
// nothing to strip.
//
// The two platforms are keyed differently on purpose; do not "align" them.
// Android needs the CHANNEL check because GitHub releases and Obtainium are a
// real free sideload channel sharing the Play build's applicationId, so the
// platform alone cannot tell them apart; VITE_BUILD_CHANNEL is set per artifact
// by build-android.sh. iOS has no equivalent: every build of the iOS app ships
// through the App Store or TestFlight, so the platform alone is the right key,
// and `npm run build:ios` sets no channel at all (CHANNEL reads 'web' there).
// This fails closed by design: no script or build path can produce an ungated
// iOS app. Web and PWA builds, including one added to an iPhone's home screen,
// report 'web' (Capacitor reports 'ios' only when its native shell has
// registered the `bridge` message handler), so they are never gated.
// The one thing that would break the iOS premise is EU alternative
// distribution: if GLANCE ever ships the iOS app outside the App Store, that
// build needs a channel of its own.
const CHANNEL = import.meta.env.VITE_BUILD_CHANNEL ?? 'web'
const isGatedChannel = (CHANNEL === 'play' && PLATFORM === 'android') || PLATFORM === 'ios'

// Safe to register unconditionally: on ungated builds the proxy is simply never
// called because the adapter below is null.
const BillingBridge = registerPlugin<CapacitorBillingPlugin>('BillingBridge')

// The plugin as the adapter sees it. On iOS, only the methods the native plugin
// implements: Capacitor's plugin proxy answers `typeof` with 'function' for ANY
// name, so passing it whole would make the engine report canConsumeTestPurchase
// for a method that rejects as UNIMPLEMENTED (consuming a test purchase is a
// Play-only operation).
const billingPlugin: CapacitorBillingPlugin = PLATFORM === 'ios'
  ? {
      initialize: (options) => BillingBridge.initialize(options),
      getStatus: () => BillingBridge.getStatus(),
      refresh: () => BillingBridge.refresh(),
      purchase: (options) => BillingBridge.purchase(options),
      getProductPrices: () => BillingBridge.getProductPrices(),
      getTrialEligibility: () => BillingBridge.getTrialEligibility(),
      addListener: (eventName, listener) => BillingBridge.addListener(eventName, listener),
    }
  : BillingBridge

const adapter = isGatedChannel
  ? createCapacitorAdapter({ plugin: billingPlugin, products: PRODUCT_IDS })
  : null

// The store's own subscription-management screen. Apple's has no per-app deep
// link; the account's subscription list is where the user cancels.
export const MANAGE_SUBSCRIPTION_URL = PLATFORM === 'ios'
  ? appleManageSubscriptionUrl()
  : playManageSubscriptionUrl('com.lastglance.app', PRODUCT_IDS.yearly)

// Store name for paywall copy ("Payment via …", "your … subscription
// settings"). Bare brand name (no article) so it reads right in the possessive.
// Every store-specific paywall string takes it through {{store}}.
export const STORE_NAME = PLATFORM === 'ios' ? 'App Store' : 'Google Play'

// The app-wide billing hook. Reviewer bypass (README rule 9: store review needs
// a way past a hard gate) uses REVIEWER_SECRET from the committed config module
// (dayGLANCE model) — the same constant the `npm run reviewer-code` CLI derives
// from, so a printed code always matches. Only load-bearing on the gated store
// builds; on ungated builds the adapter is null and nothing is behind the gate.
export function useSubscription(): UseBillingResult {
  return useBilling(() => ({
    adapter,
    // Engine-side product hints for entitlementSource classification. The
    // adapter's `products` (for querying) do NOT feed this — without passing it
    // here too, an active lifetime unlock misreports as 'subscription' (shows
    // "Annual subscription active" + a Manage-subscription button).
    products: PRODUCT_IDS,
    reviewerSecret: REVIEWER_SECRET,
  }))
}

// Leave reviewer mode (the ReviewerBanner's "Exit & view plans" action): the
// engine exposes no revoke, so clear the persisted unlock directly and reload —
// the engine re-reads the now-absent key at start and, with no entitlement, the
// hard gate (and its IAPs) returns. That way back is what App Review requires.
// The key is read from DEFAULT_STORAGE_KEYS because useSubscription passes no
// storageKeys override; deriving it from the same constant the engine falls
// back to means the cleared key can never drift from the one the engine wrote —
// the #1 bug when porting this between apps.
export function exitReviewerMode(): void {
  try {
    localStorage.removeItem(DEFAULT_STORAGE_KEYS.reviewerUnlock)
  } catch {
    // Storage unavailable — nothing was persisted, so nothing to clear.
  }
  window.location.reload()
}
