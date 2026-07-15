import { Capacitor, registerPlugin } from '@capacitor/core'
import { playManageSubscriptionUrl } from '@glance-apps/billing'
import { createCapacitorAdapter, type CapacitorBillingPlugin } from '@glance-apps/billing/capacitor'
import { useBilling, type UseBillingResult } from '@glance-apps/billing/react'
import { REVIEWER_SECRET } from '@/config/reviewerAccess'

// Play product ids, as created in the Play Console. Following the GLANCE family
// convention (dayGLANCE uses dayglance_pro_*): the subscription product
// `lastglance_pro_annual` (base plan `annual`, $4.99/yr) queried as SUBS, and the
// one-time INAPP product `lastglance_pro_lifetime` ($19.99). Permanent once
// created. Single source of truth for the app — the gate UI and the native
// plugin both derive from here.
export const PRODUCT_IDS = { yearly: 'lastglance_pro_annual', lifetime: 'lastglance_pro_lifetime' }

// Channel gating is structural (@glance-apps/billing README rule 10): only the
// Play build constructs an adapter. The GitHub sideload APK and self-hosted
// web/PWA builds pass adapter: null and are ungated by design — no debug flags,
// nothing to strip. VITE_BUILD_CHANNEL is set by build-android.sh per artifact.
const CHANNEL = import.meta.env.VITE_BUILD_CHANNEL ?? 'web'
const isGatedChannel = CHANNEL === 'play' && Capacitor.getPlatform() === 'android'

// Safe to register unconditionally: on non-Android the proxy is simply never
// called because the adapter below is null.
const BillingBridge = registerPlugin<CapacitorBillingPlugin>('BillingBridge')

const adapter = isGatedChannel
  ? createCapacitorAdapter({ plugin: BillingBridge, products: PRODUCT_IDS })
  : null

export const MANAGE_SUBSCRIPTION_URL = playManageSubscriptionUrl('com.lastglance.app', PRODUCT_IDS.yearly)

// Store name for paywall copy ("Payment via …", "your … subscription
// settings"). Bare brand name (no article) so it reads right in the possessive.
// Only the gated channel shows the paywall — today that's Android (Google Play);
// deriving from the platform means the planned iOS billing adapter needs no
// copy change.
export const STORE_NAME = Capacitor.getPlatform() === 'ios' ? 'App Store' : 'Google Play'

// The app-wide billing hook. Reviewer bypass (README rule 9: store review needs
// a way past a hard gate) uses REVIEWER_SECRET from the committed config module
// (dayGLANCE model) — the same constant the `npm run reviewer-code` CLI derives
// from, so a printed code always matches. Only load-bearing on the gated Play
// channel; on ungated builds the adapter is null and nothing is behind the gate.
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
