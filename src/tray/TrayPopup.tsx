import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import type { DesktopTray, DesktopTrayChore, DesktopTrayState } from '@/native/desktop'

// The desktop tray popup (docs/desktop-app.md, section 7): a widget. It renders
// the due list main derives from the widget snapshot the main window pushes,
// and never opens the database or runs a sync engine. "Mark done" queues a
// completion for the main window to apply (electron/commandQueue.ts); main
// hides the chore here until the next snapshot shows it done.

export function TrayPopup({ tray }: { tray: DesktopTray }) {
  const { t } = useTranslation()
  const [state, setState] = useState<DesktopTrayState | null>(null)

  useEffect(() => {
    let live = true
    tray.state().then((s) => { if (live && s) setState(s) }).catch(() => {})
    const off = tray.onState((s) => setState(s as DesktopTrayState))
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') tray.hide() }
    window.addEventListener('keydown', onKey)
    return () => { live = false; off(); window.removeEventListener('keydown', onKey) }
  }, [tray])

  const subtitle = (c: DesktopTrayChore): string => {
    if (c.state === 'overdue') {
      const days = Math.floor((c.elapsedDays ?? 0) - (c.targetCadenceDays ?? 0))
      return days > 0 ? t('notifications.daysOverdue', { count: days }) : t('notifications.dueToday')
    }
    return t('notifications.itsBeenDays', { count: Math.floor(c.elapsedDays ?? 0) })
  }

  return (
    <div className="h-screen flex flex-col bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 select-none">
      <div className="flex items-center gap-2 px-4 pt-3 pb-2 border-b border-slate-100 dark:border-slate-800">
        <span className="text-sm font-semibold flex-1">lastGLANCE</span>
        {state?.ready && state.counts.overdue > 0 && (
          <span className="text-xs text-red-500">{t('tray.overdue', { count: state.counts.overdue })}</span>
        )}
        {state?.ready && state.counts.soon > 0 && (
          <span className="text-xs text-amber-500">{t('tray.soon', { count: state.counts.soon })}</span>
        )}
      </div>
      <ul className="flex-1 min-h-0 overflow-y-auto py-1">
        {state && !state.ready && <li className="px-4 py-6 text-sm text-slate-400 text-center">{t('tray.notReady')}</li>}
        {state?.ready && state.due.length === 0 && (
          <li className="px-4 py-6 text-sm text-slate-400 text-center">{t('tray.nothingDue')}</li>
        )}
        {state?.due.map((c) => (
          <li key={c.syncId} className="flex items-center gap-2 px-2">
            <button
              onClick={() => tray.open(`chore:${c.syncId}`)}
              className="flex-1 min-w-0 flex items-center gap-2 px-2 py-2 rounded-lg text-left hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${c.state === 'overdue' ? 'bg-red-500' : 'bg-amber-400'}`} />
              <span className="min-w-0">
                <span className="block text-sm truncate">{c.name}</span>
                <span className="block text-xs text-slate-400 truncate">
                  {c.categoryName ? `${c.categoryName} · ` : ''}{subtitle(c)}
                </span>
              </span>
            </button>
            <button
              onClick={() => tray.complete(c.syncId)}
              aria-label={t('notifications.markDone')}
              title={t('notifications.markDone')}
              className="p-2 rounded-lg text-slate-400 hover:text-green-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <Check size={16} />
            </button>
          </li>
        ))}
      </ul>
      <button
        onClick={() => tray.open(null)}
        className="px-4 py-2.5 text-sm text-green-600 dark:text-green-400 border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
      >
        {t('tray.open')}
      </button>
    </div>
  )
}
