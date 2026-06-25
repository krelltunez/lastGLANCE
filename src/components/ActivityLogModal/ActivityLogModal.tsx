import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw, ChevronRight, ChevronDown } from 'lucide-react'
import { type ActivityEntry, type IntentDelivery, getActivityLog, clearActivityLog, INTENTS_ACTIVITY_EVENT } from '@/intents/config'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from 'react-i18next'

interface Props {
  onClose: () => void
}

function badgeClass(type: ActivityEntry['type']): string {
  switch (type) {
    case 'sent':     return 'bg-blue-100  dark:bg-blue-900/30  text-blue-600  dark:text-blue-400'
    case 'received': return 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'
    case 'warning':  return 'bg-amber-100 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400'
    case 'error':    return 'bg-red-100   dark:bg-red-900/30   text-red-600   dark:text-red-400'
  }
}

// Visual styling for the outbound delivery chip. Deliberately NOT the red error
// palette — a "waiting for key" hold is a normal, recoverable state, not a
// failure, so it must never render through the error path.
function deliveryChipClass(delivery: IntentDelivery): string {
  switch (delivery) {
    case 'queued':    return 'bg-slate-100 dark:bg-slate-700/40  text-slate-500 dark:text-slate-400'
    case 'held':      return 'bg-amber-100 dark:bg-amber-900/30  text-amber-600 dark:text-amber-400'
    case 'delivered': return 'bg-green-100 dark:bg-green-900/30  text-green-600 dark:text-green-400'
  }
}

export function ActivityLogModal({ onClose }: Props) {
  const { t } = useTranslation()
  const [log, setLog] = useState<ActivityEntry[]>(() => getActivityLog())
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  useEscapeKey(onClose)

  // Live-refresh while open: a background flush that advances a chip
  // (queued -> waiting for key -> delivered) fires INTENTS_ACTIVITY_EVENT.
  useEffect(() => {
    const onChange = () => setLog(getActivityLog())
    window.addEventListener(INTENTS_ACTIVITY_EVENT, onChange)
    return () => window.removeEventListener(INTENTS_ACTIVITY_EVENT, onChange)
  }, [])

  function refresh() { setLog(getActivityLog()) }
  function clear() { clearActivityLog(); setLog([]); setExpandedIds(new Set()) }

  function toggleExpanded(id: string) {
    setExpandedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  return createPortal(
    <div
      className="fixed inset-0 z-60 flex items-end sm:items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-lg bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/50 flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 shrink-0 border-b border-slate-100 dark:border-slate-700/40">
          <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
            {t('activityLog.title')}
          </h2>
          <div className="flex items-center gap-4">
            <button
              onClick={refresh}
              className="flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
            >
              <RefreshCw size={11} /> {t('activityLog.refresh')}
            </button>
            {log.length > 0 && (
              <button
                onClick={clear}
                className="text-xs text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 transition-colors"
              >
                {t('activityLog.clear')}
              </button>
            )}
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4">
          {log.length === 0 ? (
            <p className="text-xs text-slate-400 dark:text-slate-500 italic">{t('activityLog.noActivity')}</p>
          ) : (
            <div className="space-y-1">
              {log.map(entry => {
                const expanded = expandedIds.has(entry.id)
                return (
                  <div
                    key={entry.id}
                    className="text-xs py-2 border-b border-slate-100 dark:border-slate-700/40 last:border-0"
                  >
                    <div className="flex items-start gap-2">
                      <span className="text-slate-400 dark:text-slate-500 tabular-nums shrink-0 pt-0.5">
                        {new Date(entry.timestamp).toLocaleString([], {
                          month: 'short', day: 'numeric',
                          hour: '2-digit', minute: '2-digit',
                        })}
                      </span>
                      <span className={`shrink-0 px-1 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${badgeClass(entry.type)}`}>
                        {entry.type}
                      </span>
                      <div className="min-w-0 break-words flex-1">
                        <span className="text-slate-600 dark:text-slate-300">{entry.message}</span>
                        {entry.direction === 'out' && entry.delivery && (
                          <span className={`ml-2 align-middle inline-block px-1 py-0.5 rounded text-[10px] font-medium ${deliveryChipClass(entry.delivery)}`}>
                            {t(`activityLog.delivery.${entry.delivery}`)}
                          </span>
                        )}
                      </div>
                      {entry.detail && (
                        <button
                          onClick={() => toggleExpanded(entry.id)}
                          className="shrink-0 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                          aria-label={expanded ? t('activityLog.collapseDetails') : t('activityLog.expandDetails')}
                        >
                          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        </button>
                      )}
                    </div>
                    {entry.detail && expanded && (
                      <p className="text-[10px] font-mono text-slate-400 dark:text-slate-500 mt-1 leading-relaxed whitespace-pre-wrap break-all pl-0">
                        {entry.detail}
                      </p>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
