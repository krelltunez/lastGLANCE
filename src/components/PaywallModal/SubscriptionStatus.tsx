import { BadgeCheck } from 'lucide-react'
import type { UseBillingResult } from '@glance-apps/billing/react'
import { MANAGE_SUBSCRIPTION_URL } from '@/billing/billing'
import { useTranslation } from 'react-i18next'

/**
 * The entitlement line, plus manage/restore actions where there is a store.
 * Lives in the settings panel's About section and is reachable on EVERY
 * channel: on an ungated build (web/PWA, GitHub sideload APK) the entitlement
 * reads 'channel' and the line says the build is fully unlocked. That is the
 * only in-app way to tell the sideload build from the gated Play one — they
 * share an applicationId, name, icon and version.
 */
export function SubscriptionStatus({ billing }: { billing: UseBillingResult }) {
  const { t } = useTranslation()

  return (
    <div>
      <div className="flex items-center gap-2">
        <BadgeCheck size={16} className="text-green-400 shrink-0" />
        <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
          {billing.entitlementSource === 'lifetime' ? t('paywall.sourceLifetime')
            : billing.entitlementSource === 'subscription' ? t('paywall.sourceSubscription')
            : billing.entitlementSource === 'reviewer' ? t('paywall.sourceReviewer')
            : billing.entitlementSource === 'channel' ? t('paywall.sourceChannel')
            : t('paywall.sourceNone')}
        </p>
      </div>
      {billing.productId && (
        <p className="text-xs text-slate-400 dark:text-slate-500 ml-6 mt-0.5">{billing.productId}</p>
      )}
      {/* Store actions only where there is a store to talk to. On an
          ungated channel entitlementSource is 'channel', the engine has
          no adapter, and Restore could only ever report "nothing to
          restore" — so the status line stands alone. */}
      {billing.entitlementSource !== 'channel' && (
        <div className="space-y-2 mt-3">
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
      )}
    </div>
  )
}
