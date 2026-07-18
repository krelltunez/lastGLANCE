import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Check, Loader, BadgeCheck, KeyRound } from 'lucide-react'
import type { UseBillingResult } from '@glance-apps/billing/react'
import { PRODUCT_IDS, MANAGE_SUBSCRIPTION_URL, STORE_NAME } from '@/billing/billing'
import { useTranslation } from 'react-i18next'

interface Props {
  billing: UseBillingResult
  // 'gate': the hard paywall on a locked Play install — fullscreen, not
  // dismissible (store review passes it via the reviewer code, rule 9).
  // 'status': the settings surface on an unlocked install — dismissible,
  // shows the entitlement and manage/restore actions.
  mode: 'gate' | 'status'
  onClose?: () => void
}

export function PaywallModal({ billing, mode, onClose }: Props) {
  const { t } = useTranslation()
  const [showCode, setShowCode] = useState(false)
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState(false)

  async function submitCode() {
    if (!code.trim()) return
    const ok = await billing.setReviewerUnlocked(code.trim())
    if (!ok) setCodeError(true)
  }

  const isError = billing.billingEvent?.status === 'error'
  const restored = billing.billingEvent?.message === 'restore_complete'

  // Prices come from the store or not at all (no hardcoded strings — package
  // README rule 8). Null renders a quiet placeholder until the store answers.
  const yearlyPrice = billing.prices.yearly
  const lifetimePrice = billing.prices.lifetime

  // Trial-forward copy, all driven by the store's own offer (no hardcoded
  // lengths — rule 8): trialDays/trialEligible come from the Play offer on the
  // annual base plan. Trial copy requires BOTH eligibility and a known length:
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
    <div className={`fixed inset-0 z-[80] flex items-end sm:items-center justify-center app-safe-bottom ${mode === 'gate' ? 'bg-slate-50 dark:bg-slate-950' : 'bg-black/40 dark:bg-black/60 backdrop-blur-sm'}`}
      onClick={mode === 'status' ? e => { if (e.target === e.currentTarget) onClose?.() } : undefined}
    >
      <div className="w-full sm:max-w-sm bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl border border-slate-200 dark:border-slate-700/50 max-h-[90svh] overflow-y-auto">
        <div className="flex items-start justify-between mb-1">
          <h2 className="text-2xl font-black tracking-tight text-slate-900 dark:text-slate-100">
            last<span className="italic text-green-400">GLANCE</span>
          </h2>
          {mode === 'status' && (
            <button onClick={onClose} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
              <X size={16} />
            </button>
          )}
        </div>

        {mode === 'status' ? (
          <>
            <div className="flex items-center gap-2 mt-4 mb-1">
              <BadgeCheck size={16} className="text-green-400 shrink-0" />
              <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
                {billing.entitlementSource === 'lifetime' ? t('paywall.sourceLifetime')
                  : billing.entitlementSource === 'subscription' ? t('paywall.sourceSubscription')
                  : billing.entitlementSource === 'reviewer' ? t('paywall.sourceReviewer')
                  : t('paywall.sourceNone')}
              </p>
            </div>
            {billing.productId && (
              <p className="text-xs text-slate-400 dark:text-slate-500 ml-6 mb-4">{billing.productId}</p>
            )}
            <div className="space-y-2 mt-4">
              {billing.entitlementSource === 'subscription' && (
                <button
                  onClick={() => window.open(MANAGE_SUBSCRIPTION_URL, '_blank')}
                  className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
                >
                  {t('paywall.manage')}
                </button>
              )}
              <button
                onClick={() => billing.restore()}
                className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
              >
                {t('paywall.restore')}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-2">{t('paywall.pitch')}</p>

            {/* Named benefits, not just scope: App Store review rejects paywalls
                that don't describe what the price buys (Guideline 3.1.2 —
                dayGLANCE learned this the hard way), and the list reads fine on
                Play too. Keep it to what the unlock actually includes. */}
            <ul className="mt-3 space-y-1.5">
              {(['featureWidgets', 'featureReminders', 'featureSync', 'featureUsers', 'featureIntegrations'] as const).map(k => (
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
                onClick={() => { billing.clearBillingEvent(); billing.subscribe(PRODUCT_IDS.yearly) }}
                disabled={billing.isLoading}
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
                onClick={() => { billing.clearBillingEvent(); billing.subscribe(PRODUCT_IDS.lifetime) }}
                disabled={billing.isLoading}
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

            <div className="flex items-center justify-between mt-5">
              <button
                onClick={() => billing.restore()}
                className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors inline-flex items-center gap-1.5"
              >
                {billing.isLoading && <Loader size={11} className="animate-spin" />}
                {t('paywall.restore')}
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
          </>
        )}
      </div>
    </div>
  )

  return createPortal(body, document.body)
}
