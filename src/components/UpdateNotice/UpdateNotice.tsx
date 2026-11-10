import { ArrowDownToLine, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { UpdateNotice as Update } from '@/hooks/useUpdateNotice'

// A small card in the corner when a newer desktop release can be downloaded
// (useUpdateNotice). Download opens the release page in the browser.
export function UpdateNotice({ update, onDismiss }: { update: Update; onDismiss: () => void }) {
  const { t } = useTranslation()
  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-[70] max-w-xs flex items-center gap-3 pl-4 pr-2 py-2.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-lg"
    >
      <ArrowDownToLine size={16} className="text-green-500 dark:text-green-400 shrink-0" />
      <p className="text-sm text-slate-700 dark:text-slate-200 flex-1 min-w-0">{t('update.available', { version: update.version })}</p>
      <button
        onClick={() => { window.open(update.url, '_blank'); onDismiss() }}
        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold bg-green-500 text-white hover:bg-green-400 transition-colors"
      >
        {t('update.download')}
      </button>
      <button
        onClick={onDismiss}
        aria-label={t('update.dismiss')}
        className="shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  )
}
