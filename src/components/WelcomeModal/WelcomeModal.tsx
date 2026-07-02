import { Clock, Bell, Leaf, Cloud, Loader } from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from 'react-i18next'

interface Props {
  onGetStarted: () => void
  onClearSample: () => Promise<void>
  clearing: boolean
}

export function WelcomeModal({ onGetStarted, onClearSample, clearing }: Props) {
  const { t } = useTranslation()

  const BULLETS = [
    { icon: Clock,  label: t('welcome.cadenceLabel'),   text: t('welcome.cadenceText') },
    { icon: Bell,   label: t('welcome.remindersLabel'), text: t('welcome.remindersText') },
    { icon: Leaf,   label: t('welcome.seasonalLabel'),  text: t('welcome.seasonalText') },
    { icon: Cloud,  label: t('welcome.syncLabel'),      text: t('welcome.syncText') },
  ]

  useEscapeKey(onGetStarted)

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center app-safe-bottom bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onGetStarted() }}
    >
      <div className="w-full sm:max-w-sm bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl border border-slate-200 dark:border-slate-700/50">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200 mb-1">
          {t('welcome.title')}
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-4 leading-relaxed">
          {t('welcome.description')}
        </p>

        <ul className="space-y-3 mb-5">
          {BULLETS.map(({ icon: Icon, label, text }) => (
            <li key={label} className="flex items-start gap-3">
              <Icon size={14} className="text-green-400 shrink-0 mt-0.5" />
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                <span className="font-semibold text-slate-700 dark:text-slate-200">{label} — </span>
                {text}
              </p>
            </li>
          ))}
        </ul>

        <div className="flex gap-3">
          <button
            onClick={onClearSample}
            disabled={clearing}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {clearing ? <><Loader size={13} className="animate-spin" />{t('welcome.clearing')}</> : t('welcome.clearSampleData')}
          </button>
          <button
            onClick={onGetStarted}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white bg-green-500 hover:bg-green-400 transition-colors"
          >
            {t('welcome.getStarted')}
          </button>
        </div>
      </div>
    </div>
  )
}
