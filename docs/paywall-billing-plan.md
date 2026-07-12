# Paywall / Billing Plan — lastGLANCE (and the GLANCE family)

Decision record and integration plan for monetizing lastGLANCE on Google Play,
plus the extraction spec for a shared `@glance-apps/paywall` package. Written
from the lastGLANCE side; the extraction itself happens in a dayGLANCE session
using this document as the contract.

## Context (decided 2026-07, see CLAUDE.md)

- The Play listing is **locked free** (published to a testing track as free;
  Google permanently blocks free→paid). Monetization is therefore **in-app via
  Play Billing** on the existing app entry — no new listing, no closed-test
  redo.
- **Model: mirror dayGLANCE** — annual subscription + lifetime one-time
  purchase, both granting the same entitlement. Working prices: $4.99/yr,
  $19.99 lifetime (final prices live in Play Console, not in code).
- The paywall is extracted from dayGLANCE into a **shared package**
  (`@glance-apps/paywall`), following the family pattern of `@glance-apps/sync`
  and `@glance-apps/intents`: pure-TS core, thin per-app native adapter,
  pinned exact versions in consumers.
- Distribution split: **Play build gated; GitHub sideload APK and self-hosted
  web/PWA unlocked** (dayGLANCE-style). iOS later via a StoreKit adapter.

## Package architecture (`@glance-apps/paywall`)

Headless core, no UI. Each app ships its own gate UI matching its design
system (lastGLANCE: Tailwind modal consistent with existing modals; copy can
be adapted from dayGLANCE's).

### Core (pure TS, platform-agnostic)

```ts
export interface ProductIds {
  annual: string      // subscription product id
  lifetime: string    // one-time INAPP product id
}

export interface PaywallConfig {
  productIds: ProductIds
  channel: 'play' | 'github' | 'web' | 'dev'
  unlockedChannels: Array<PaywallConfig['channel']>  // bypass the gate entirely
  storageKey: string       // entitlement cache slot (localStorage)
  graceDays: number        // offline grace beyond subscription expiry
}

export interface EntitlementState {
  unlocked: boolean
  source: 'lifetime' | 'subscription' | 'channel' | 'none'
  subExpiresAt: string | null   // ISO, when source is subscription
  lastVerifiedAt: string | null
}

export function createPaywall(config: PaywallConfig, adapter: BillingAdapter): {
  getState(): EntitlementState
  refresh(): Promise<EntitlementState>     // re-query adapter, update cache
  purchase(kind: 'annual' | 'lifetime'): Promise<PurchaseResult>
  restore(): Promise<EntitlementState>
  getProducts(): Promise<ProductInfo[]>    // localized prices for the gate UI
  subscribe(cb: (s: EntitlementState) => void): () => void
}
```

Entitlement rule: `unlocked = lifetimeOwned || subExpiresAt + graceDays > now
|| channel ∈ unlockedChannels`.

**Local-first constraint (non-negotiable):** the entitlement is cached in
localStorage and evaluated synchronously at startup; `refresh()` runs
opportunistically (launch/resume, billing available). A paying user is never
locked out offline — the grace window absorbs airplane mode, dead zones, and
Play outages. Client-side gating is honor-system against determined tampering;
that is accepted (same posture as dayGLANCE).

### Adapter interface (per app, thin native bridge)

```ts
export interface BillingAdapter {
  available(): Promise<boolean>                 // false on web/GitHub/iOS-for-now
  queryProducts(ids: ProductIds): Promise<ProductInfo[]>
  queryEntitlements(): Promise<RawEntitlements> // owned purchases + sub expiry
  purchase(productId: string): Promise<PurchaseResult>
  manageSubscriptionUrl(): string | null        // Play subscriptions deep link
}
```

- **dayGLANCE adapter**: wraps its existing `addJavascriptInterface` billing
  bridge (extraction target — the native Java/Kotlin billing code stays in the
  dayGLANCE shell, reshaped to this interface).
- **lastGLANCE adapter**: a thin custom Capacitor plugin (`BillingBridge`) over
  Play Billing Library — same style as the existing `WidgetBridge` /
  `IntentsBridge` plugins. The Java side can be cribbed from dayGLANCE's
  proven billing code. Alternative considered: `cordova-plugin-purchase`
  (battle-tested but heavyweight/opinionated); custom-thin is preferred for
  parity with family conventions and the privacy story (no third-party SDK,
  no RevenueCat — purchase data stays between the app and Google Play, so the
  Data safety form is unchanged).

## lastGLANCE integration map

| Piece | Where |
|---|---|
| Channel flag | `VITE_BUILD_CHANNEL` (`play` / `github` / `web`; default `web`). Follows the existing `VITE_*` convention. |
| Paywall init | `src/billing/paywall.ts` — config + adapter wiring, exported singleton like the sync engine |
| Gate UI | New `PaywallModal` (Tailwind, matches existing modals): annual + lifetime cards with localized prices, restore link, manage-subscription link |
| Gate policy | Hard gate at app open on the `play` channel when not unlocked (mirror dayGLANCE; confirm its exact policy during extraction — trial/preview behavior, if any) |
| Settings surface | Entry in the settings sheet: shows entitlement state, restore purchases, manage subscription |
| Native plugin | `android/.../billing/BillingBridgePlugin.java` (+ registration in `MainActivity`) |

## Build pipeline change (required)

`build-android.sh --release` currently builds web assets **once** and produces
both the sideload APK and the Play AAB from the same `dist/`. With a
channel-split paywall those artifacts differ:

1. Build web with `VITE_BUILD_CHANNEL=github` → `assembleRelease` → sideload APK (ungated)
2. Build web with `VITE_BUILD_CHANNEL=play` → `bundleRelease` → Play AAB (gated)

Same versionCode for both is fine. Docker/web builds default to `web`
(ungated, billing unavailable).

## Play Console sequence

1. Merchant/payments profile verified (required to create products).
2. Upload a billing-permission build to **internal testing** first — products
   can only be created once such a build exists on a track.
3. Create products: subscription (annual base plan) + one-time lifetime
   product. Expect **hours of propagation** before they are purchasable.
4. **License testers** (Setup → License testing): test purchases without
   charges. Verify: purchase annual, purchase lifetime, restore on reinstall,
   cancel/expiry handling, offline grace.
5. One submission to production with the gated build. **Managed publishing
   ON**; publish in coordination with the GitHub release (ungated APK).

Launch build stays **v2.0.0 / versionCode 2000000** — nothing has been
submitted to production yet, so no override juggling is needed.

## Extraction handoff (for the dayGLANCE session)

Inventory dayGLANCE's paywall and reshape to this spec, preserving proven
behavior:

- Entitlement persistence + refresh cadence (map to `EntitlementState`/cache)
- Native billing bridge (becomes dayGLANCE's `BillingAdapter`; Java/Kotlin
  billing internals are also the reference for lastGLANCE's Capacitor plugin)
- Gate policy + UX copy (reference for lastGLANCE's modal)
- The GitHub-build flag mechanism (its channel equivalent)
- Package repo: same home/publish flow as `glance-sync` / `glance-intents`;
  consumers pin exact versions per family convention.

## Open decisions

- Final prices and whether the gate offers any preview/trial (mirror dayGLANCE
  unless there's a reason not to).
- Product ids (proposal: `pro_annual` subscription with `annual` base plan;
  `pro_lifetime` INAPP).
- Package name (`@glance-apps/paywall` vs `@glance-apps/billing`).
- lifeGLANCE adoption timing (entry also locked free; same integration once
  the package exists).
