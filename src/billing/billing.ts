import { Capacitor, registerPlugin } from '@capacitor/core'
import { playManageSubscriptionUrl } from '@glance-apps/billing'
import { createCapacitorAdapter, type CapacitorBillingPlugin } from '@glance-apps/billing/capacitor'
import { useBilling, type UseBillingResult } from '@glance-apps/billing/react'

// Play product ids, as created in the Play Console (docs/paywall-billing-plan.md):
// the subscription product `pro` (base plan `annual`, $4.99/yr) queried as SUBS,
// and the one-time INAPP product `pro_lifetime` ($19.99). Single source of truth
// for the whole app — the gate UI and the native plugin both derive from here.
export const PRODUCT_IDS = { yearly: 'pro', lifetime: 'pro_lifetime' }

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

// The app-wide billing hook. Reviewer bypass (README rule 9: store review needs
// a way past a hard gate) is derived from VITE_REVIEWER_SECRET, injected at
// build time for the Play channel only — build-android.sh warns when unset.
export function useSubscription(): UseBillingResult {
  return useBilling(() => ({
    adapter,
    reviewerSecret: import.meta.env.VITE_REVIEWER_SECRET ?? null,
  }))
}
