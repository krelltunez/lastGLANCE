// Billing on the Mac App Store build (docs/desktop-app.md, section 9). Under
// Universal Purchase the Mac app shares the iOS app's App Store products and
// its RevenueCat App Store app, so these are the iOS values:
// billingConfig.test.ts holds them equal to src/billing/billing.ts
// (PRODUCT_IDS), ios/App/App/AppDelegate.swift (the public SDK key) and
// ios/App/App/plugins/RevenueCatBilling.swift (the entitlement).
//
// Only the MAS build registers billing (main.ts, process.mas), and
// @glance-apps/billing/electron-main checks for the App Store receipt on its
// own: two independent signals that every other desktop build is free.

export const MAS_BILLING = {
  rcApiKey: 'appl_xWQMlBxhFQklvPrhJlwwwSkuCWX',
  entitlementId: 'pro',
  products: { yearly: 'lastglance_pro_annual', lifetime: 'lastglance_pro_lifetime' },
} as const;
