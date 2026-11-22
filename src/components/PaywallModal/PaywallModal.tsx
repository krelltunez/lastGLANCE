import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Check, Loader, KeyRound } from 'lucide-react'
import type { UseBillingResult } from '@glance-apps/billing/react'
import { BILLING_CODE_PENDING } from '@glance-apps/billing'
import { GATE_DISMISSIBLE, PAYWALL_FEATURES, PRODUCT_IDS, STORE_NAME } from '@/billing/billing'
import { leaveApp } from '@/native/backButton'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from 'react-i18next'

interface Props {
  billing: UseBillingResult
}

// How long the Restore control stays busy with no outcome before it gives up
// showing so. Well past the Mac App Store's ten-second wait plus a slow network.
const RESTORE_GIVE_UP_MS = 45_000

// The hard paywall on a locked store install (Play or App Store) — fullscreen, not dismissible
// (store review passes it via the reviewer code, rule 9). The entitlement
// status for unlocked installs is SubscriptionStatus, in the settings panel.
export function PaywallModal({ billing }: Props) {
  const { t } = useTranslation()
  const [showCode, setShowCode] = useState(false)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState(false)

  // Whether a restore is under way: asked for, and no outcome yet. A restore
  // can take a while to answer. On the Mac App Store build "nothing to restore"
  // takes ten seconds and more, by design: StoreKit sends no signal when it
  // finds nothing, so main waits that long for a restored purchase before it
  // asks RevenueCat (@glance-apps/billing, restoreFallbackMs). With nothing on
  // screen for that long, the control looked dead.
  const [restoreAsked, setRestoreAsked] = useState(false)
  const restoring = restoreAsked && !billing.billingEvent
  // Every restore ends in an event; this is for the one that somehow does not,
  // so the control cannot stay busy for good.
  useEffect(() => {
    if (!restoring) return
    const timer = setTimeout(() => setRestoreAsked(false), RESTORE_GIVE_UP_MS)
    return () => clearTimeout(timer)
  }, [restoring])

  function startRestore() {
    // The last outcome goes first: a second press must not sit under the first
    // one's "No previous purchase found" as if it had already answered.
    billing.clearBillingEvent()
    setRestoreAsked(true)
    billing.restore()
  }

  function buy(productId: string) {
    billing.clearBillingEvent()
    setRestoreAsked(false)
    billing.subscribe(productId)
  }
  // The gate sits above everything, so it owns Back (and Escape) while it is
  // up: both leave the app, exactly like its X. Without this, Back would
  // dismiss whatever is underneath, such as the welcome screen.
  useEscapeKey(leaveApp)

  async function submitCode() {
    if (!code.trim()) return
    const ok = await billing.setReviewerUnlocked(code.trim())
    if (!ok) setCodeError(true)
  }

  const isError = billing.billingEvent?.status === 'error'
  const restored = billing.billingEvent?.message === 'restore_complete'

  // A purchase that ended neither failed nor confirmed (@glance-apps/billing
  // 0.2.4). Deferred: waiting for someone's approval (Ask to Buy). Otherwise
  // unconfirmed: the store completed it but the entitlement has not appeared.
  // Either way the app unlocks on its own when it does, from RevenueCat's
  // update; nothing here sends anyone to Restore, which would find nothing yet.
  // Both strings are English in every bundle until the locale pass translates
  // them; UNTRANSLATED in src/locales.test.ts tracks who is waiting.
  const pending = billing.billingEvent?.status === 'pending' ? billing.billingEvent : null
  const pendingText = !pending ? null
    : pending.code === BILLING_CODE_PENDING
      ? t('paywall.purchasePendingApproval')
      : t('paywall.purchaseUnconfirmed')

  // Prices come from the store or not at all (no hardcoded strings — package
  // README rule 8). Null renders a quiet placeholder until the store answers.
  const yearlyPrice = billing.prices.yearly
  const lifetimePrice = billing.prices.lifetime

  // Trial-forward copy, all driven by the store's own offer (no hardcoded
  // lengths — rule 8): trialDays/trialEligible come from the store's own offer
  // (Play: the annual base plan's free phase; App Store: the introductory offer). Trial copy requires BOTH eligibility and a known length:
  // the adapter's pre-fetch state is optimistically eligible with days unknown,
  // so gating on days too keeps trial language from flashing at users whose
  // trial is already spent (the store omits the free phase for them, so a
  // length never arrives). An eligible user just sees the plain gate for the
  // beat until the store answers — under-promising in the safe direction.
  const days = billing.trialDays
  const hasTrial = billing.trialEligible && days != null

  const headline = hasTrial ? t('paywall.trialHeadline', { count: days }) : t('paywall.gateHeadline')
  // The pitch is now the always-on tagline under the wordmark, so the subtitle
  // is trial-only; non-trial gets the tagline + headline and no subtitle.
  const subtitle = hasTrial ? t('paywall.trialSubtitle', { count: days }) : null

  // Annual card sub-line: "{n}-day free trial, then {price}/yr" once both known.
  const annualSub = hasTrial
    ? (yearlyPrice
        ? t('paywall.annualTrialThen', { count: days, price: yearlyPrice })
        : t('paywall.trialDays', { count: days }))
    : null

  // Renewal/finance explainer beneath the cards. It names the price, so it
  // appears once the store answers; the store name is platform-derived.
  const explainer = yearlyPrice
    ? (hasTrial
        ? t('paywall.trialExplainer', { count: days, price: yearlyPrice, store: STORE_NAME })
        : t('paywall.subExplainer', { price: yearlyPrice, store: STORE_NAME }))
    : null

  const body = (
    <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center app-safe-bottom bg-slate-50 dark:bg-slate-950">
      <div className="w-full sm:max-w-sm bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl border border-slate-200 dark:border-slate-700/50 max-h-[90svh] overflow-y-auto">
        <div className="flex items-start justify-between mb-1">
          <h2 className="text-2xl font-black tracking-tight text-slate-900 dark:text-slate-100">
            last<span className="italic text-green-400">GLANCE</span>
          </h2>
          {/* Gate dismiss control (Play Subscriptions policy). Deliberately the
             body-copy color, not the muted footer token — it must be obvious
             against the card. 22px glyph; the 12px padding makes a 46px hit
             target; negative margins keep the glyph aligned with the wordmark
             and the card's padding edge. leaveApp is also what the gate
             registers for Back (useEscapeKey above), so X and back are
             identical by construction. Not rendered on iOS, where leaving
             is not something an app may do (GATE_DISMISSIBLE). */}
          {GATE_DISMISSIBLE && (
            <button
              onClick={leaveApp}
              aria-label="Close"
              className="p-3 -mt-2 -mr-3 rounded-xl text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-green-400"
            >
              <X size={22} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
        </div>

        <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">{t('paywall.pitch')}</p>

        {/* Play policy: the purchase requirement must be stated plainly on
            the gate. Body size and the body-copy color on purpose — this is
            not fine print. */}
        <p className="text-sm text-slate-600 dark:text-slate-300 mt-2">{t('paywall.requiredNotice')}</p>

        {/* Named benefits, not just scope: App Store review rejects paywalls
            that don't describe what the price buys (Guideline 3.1.2 —
            dayGLANCE learned this the hard way), and the list reads fine on
            Play too. Keep it to what the unlock actually includes on this
            build: PAYWALL_FEATURES leaves out the widgets on the Mac and
            Tasker everywhere but Android. */}
        <ul className="mt-3 space-y-1.5">
          {PAYWALL_FEATURES.map(k => (
            <li key={k} className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
              <Check size={14} className="text-green-400 shrink-0" />
              {t(`paywall.${k}`)}
            </li>
          ))}
        </ul>

        <h3 className="text-xl font-bold tracking-tight text-slate-900 dark:text-slate-100 mt-4">{headline}</h3>
        {subtitle && <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">{subtitle}</p>}

        <div className="space-y-3 mt-5">
          {/* Annual */}
          <button
            onClick={() => buy(PRODUCT_IDS.yearly)}
            disabled={billing.isLoading || restoring}
            className="w-full text-left p-4 rounded-xl border-2 border-green-400/60 hover:border-green-400 bg-green-400/5 hover:bg-green-400/10 transition-colors disabled:opacity-50"
          >
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('paywall.annualTitle')}</span>
              <span className="text-sm font-bold text-slate-900 dark:text-slate-50 tabular-nums">
                {yearlyPrice ? t('paywall.annualPer', { price: yearlyPrice }) : '…'}
              </span>
            </div>
            {annualSub && (
              <p className="text-xs text-green-500 dark:text-green-400 mt-1">{annualSub}</p>
            )}
          </button>

          {/* Lifetime */}
          <button
            onClick={() => buy(PRODUCT_IDS.lifetime)}
            disabled={billing.isLoading || restoring}
            className="w-full text-left p-4 rounded-xl border border-slate-200 dark:border-slate-600 hover:border-slate-300 dark:hover:border-slate-500 bg-slate-50 dark:bg-slate-700/40 transition-colors disabled:opacity-50"
          >
            <div className="flex items-baseline justify-between">
              <span className="inline-flex items-baseline gap-2">
                <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('paywall.lifetimeTitle')}</span>
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-green-400 text-slate-900">
                  {t('paywall.bestValue')}
                </span>
              </span>
              <span className="text-sm font-bold text-slate-900 dark:text-slate-50 tabular-nums">
                {lifetimePrice ? t('paywall.lifetimeOnce', { price: lifetimePrice }) : '…'}
              </span>
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{t('paywall.lifetimeHint')}</p>
          </button>
        </div>

        {explainer && (
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-4 leading-relaxed">{explainer}</p>
        )}
        <p className="text-xs text-slate-400 dark:text-slate-500 mt-2">{t('paywall.paymentVia', { store: STORE_NAME })}</p>

        {isError && billing.billingEvent && (
          <p className="text-xs text-red-500 dark:text-red-400 mt-3">
            {billing.billingErrorMessage(billing.billingEvent.code)}
          </p>
        )}
        {restored && (
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-3">{t('paywall.nothingToRestore')}</p>
        )}
        {pendingText && (
          <p role="status" className="text-xs text-slate-600 dark:text-slate-300 mt-3">{pendingText}</p>
        )}

        <div className="flex items-center justify-between mt-5">
          <button
            onClick={startRestore}
            disabled={restoring}
            aria-busy={restoring}
            className={`text-xs transition-colors inline-flex items-center gap-1.5 ${restoring ? 'text-slate-600 dark:text-slate-200 cursor-progress' : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200'}`}
          >
            {(billing.isLoading || restoring) && <Loader size={11} className="animate-spin" />}
            {restoring ? t('backup.restoring') : t('paywall.restore')}
          </button>
          {/* Reviewer bypass entry (store review, rule 9) — explicitly labeled
              so users don't mistake it for a promo/redeem field. */}
          <button
            onClick={() => setShowCode(s => !s)}
            className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors inline-flex items-center gap-1.5"
          >
            <KeyRound size={11} />
            {t('paywall.reviewerAccess')}
          </button>
        </div>

        {showCode && (
          <div className="mt-3">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={code}
                onChange={e => { setCode(e.target.value); setCodeError(false) }}
                onKeyDown={e => { if (e.key === 'Enter') submitCode() }}
                placeholder={t('paywall.codePlaceholder')}
                className="flex-1 bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
              <button onClick={submitCode} className="text-xs font-medium text-green-500 hover:text-green-400 shrink-0">
                {t('paywall.codeSubmit')}
              </button>
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500 mt-2">{t('paywall.reviewerHint')}</p>
          </div>
        )}
        {codeError && (
          <p className="text-xs text-red-500 dark:text-red-400 mt-2">{t('paywall.codeInvalid')}</p>
        )}

        {/* Legal links on the wall itself: Apple 3.1.2 requires a privacy
            policy and Terms of Use link on the subscription paywall (the
            Help-modal links alone don't satisfy it); harmless on Play.
            Labels reuse the localized help.* strings. */}
        <div className="flex items-center justify-center gap-3 mt-5 text-[11px] text-slate-400 dark:text-slate-500">
          <a
            href="https://www.glance-apps.com/lastglance/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
          >
            {t('help.privacyPolicy')}
          </a>
          <span aria-hidden="true">·</span>
          <a
            href="https://www.glance-apps.com/eula"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
          >
            {t('help.termsOfUse')}
          </a>
        </div>
      </div>
    </div>
  )

  return createPortal(body, document.body)
}
