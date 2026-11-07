import { ExternalLink, Smartphone } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { LAUNCHER_NAME, type PromoLink } from '@/native/launcherPromo'

// The GLANCElauncher promotion's two places in Settings (src/native/launcherPromo.ts
// decides whether either shows; src/hooks/useLauncherPromo.ts feeds them).

// The store link. An anchor with target _blank, as the Help links do: the
// native shell hands it to the system browser or the Play Store.
function PromoLinkButton({ link }: { link: PromoLink }) {
  const { t } = useTranslation()
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-green-400 border border-green-400/40 hover:bg-green-400/10 transition-colors"
    >
      <ExternalLink size={13} className="shrink-0" />
      {link.store === 'play' ? t('settings.launcherPromo.getOnPlay') : t('settings.launcherPromo.viewOnGithub')}
    </a>
  )
}

// The one-time card at the top of Settings.
export function LauncherPromoCard({ link, onDismiss }: { link: PromoLink; onDismiss: () => void }) {
  const { t } = useTranslation()
  return (
    <section
      aria-labelledby="launcher-promo-title"
      data-testid="launcher-promo-card"
      className="mx-1 mb-2 rounded-2xl border border-green-400/40 bg-green-400/5 p-4 space-y-3"
    >
      <h3 id="launcher-promo-title" className="flex items-center gap-2 text-sm font-semibold text-green-500 dark:text-green-400">
        <Smartphone size={16} className="shrink-0" />
        {LAUNCHER_NAME}
      </h3>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t('settings.launcherPromo.body')}</p>
      <div className="flex flex-wrap gap-2">
        <PromoLinkButton link={link} />
        <button
          type="button"
          onClick={onDismiss}
          className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
        >
          {t('settings.launcherPromo.notNow')}
        </button>
      </div>
    </section>
  )
}

// The permanent entry under Integrations: the same words and link, no dismiss.
export function LauncherPromoEntry({ link }: { link: PromoLink }) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="launcher-promo-entry"
      className="px-3 py-3 rounded-lg border border-slate-200 dark:border-slate-700 space-y-2"
    >
      <div className="flex items-center gap-2.5 text-sm font-medium text-slate-700 dark:text-slate-200">
        <Smartphone size={15} className="shrink-0 text-slate-400 dark:text-slate-500" />
        {LAUNCHER_NAME}
      </div>
      <p className="text-sm text-slate-500 dark:text-slate-400">{t('settings.launcherPromo.body')}</p>
      <PromoLinkButton link={link} />
    </div>
  )
}
