import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X, RefreshCw } from 'lucide-react'
import { type ActivityEntry, getActivityLog, clearActivityLog } from '@/intents/config'
import { useEscapeKey } from '@/hooks/useEscapeKey'

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

export function ActivityLogModal({ onClose }: Props) {
  const [log, setLog] = useState<ActivityEntry[]>(() => getActivityLog())

  useEscapeKey(onClose)

  function refresh() { setLog(getActivityLog()) }
  function clear() { clearActivityLog(); setLog([]) }

  return createPortal(
    <div
      className="fixed inset-0 z-60 flex items-end sm:items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-lg bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/50 flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 shrink-0 border-b border-slate-100 dark:border-slate-700/40">
          <h2 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
            Activity Log
          </h2>
          <div className="flex items-center gap-4">
            <button
              onClick={refresh}
              className="flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
            >
              <RefreshCw size={11} /> Refresh
            </button>
            {log.length > 0 && (
              <button
                onClick={clear}
                className="text-xs text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 transition-colors"
              >
                Clear
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
            <p className="text-xs text-slate-400 dark:text-slate-500 italic">No activity yet.</p>
          ) : (
            <div className="space-y-1">
              {log.map(entry => (
                <div
                  key={entry.id}
                  className="flex items-start gap-2 text-xs py-2 border-b border-slate-100 dark:border-slate-700/40 last:border-0"
                >
                  <span className="text-slate-400 dark:text-slate-500 tabular-nums shrink-0 pt-0.5">
                    {new Date(entry.timestamp).toLocaleString([], {
                      month: 'short', day: 'numeric',
                      hour: '2-digit', minute: '2-digit',
                    })}
                  </span>
                  <span className={`shrink-0 px-1 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${badgeClass(entry.type)}`}>
                    {entry.type}
                  </span>
                  <div className="min-w-0 break-words">
                    <span className="text-slate-600 dark:text-slate-300">{entry.message}</span>
                    {entry.detail && (
                      <p className="text-[10px] font-mono text-slate-400 dark:text-slate-500 mt-1 leading-relaxed whitespace-pre-wrap break-all">
                        {entry.detail}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
