import { ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface Props {
  onExit: () => void
}

// Shown while the install is reviewer-unlocked (store-review bypass code —
// never a paying customer, who is entitled via Play/StoreKit instead). Ported
// from dayGLANCE (docs/reviewer-access-flow.md): the launch paywall is the only
// IAP surface, so once the bypass code hides it the reviewer needs a way BACK
// to locate and test the purchases (Guideline 2.1(b) / Play app-access).
// "Exit & view plans" revokes the unlock and returns to the wall.
//
// Differences from the dayGLANCE original: theme comes from Tailwind's class
// strategy (dark: variants) rather than a darkMode prop, the copy is localized,
// and the top padding honors the safe-area inset because this app draws under
// the transparent Android status bar (StatusBar.overlaysWebView).
export function ReviewerBanner({ onExit }: Props) {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      className="fixed top-0 inset-x-0 z-[90] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 pb-2 text-xs bg-amber-100 text-amber-900 border-b border-amber-300 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30"
      style={{ paddingTop: 'max(0.5rem, env(safe-area-inset-top))' }}
    >
      <span className="flex items-center gap-1.5 font-medium">
        <ShieldCheck size={14} className="shrink-0" />
        {t('paywall.bannerActive')}
      </span>
      <button
        onClick={onExit}
        className="rounded-full px-3 py-1 font-semibold transition-colors bg-amber-600 text-white hover:bg-amber-700 dark:bg-amber-400 dark:text-amber-950 dark:hover:bg-amber-300"
      >
        {t('paywall.bannerExit')}
      </button>
    </div>
  )
}
