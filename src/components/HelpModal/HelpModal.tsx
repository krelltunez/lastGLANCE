import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, HelpCircle, ExternalLink } from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'

interface Props {
  onClose: () => void
  onOpenShortcuts: () => void
}

function ExternalLinkRow({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2 text-sm text-green-400 hover:text-green-300 transition-colors"
    >
      <ExternalLink size={14} className="shrink-0" />
      {label}
    </a>
  )
}

export function HelpModal({ onClose, onOpenShortcuts }: Props) {
  const [storage, setStorage] = useState<{ used: number; quota: number } | null>(null)

  useEscapeKey(onClose)

  useEffect(() => {
    navigator.storage?.estimate().then(est => {
      if (est.usage != null && est.quota != null) {
        setStorage({ used: est.usage, quota: est.quota })
      }
    }).catch(() => {})
  }, [])

  function fmtBytes(n: number): string {
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
    return `${(n / (1024 * 1024)).toFixed(1)} MB`
  }

  const buildDate = new Date(__BUILD_TIME__).toLocaleString(undefined, {
    dateStyle: 'medium', timeStyle: 'short',
  })

  return createPortal(
    <div
      className="fixed inset-0 z-60 flex items-end sm:items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-sm bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/50 flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 pt-5 pb-4 border-b border-slate-100 dark:border-slate-700/40">
          <HelpCircle size={20} className="text-green-400 shrink-0" />
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100 flex-1">
            Help &amp; Feedback
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-4 space-y-5">
          {/* Contact & Issues */}
          <div className="space-y-2.5">
            <p className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">
              Contact &amp; Issues
            </p>
            <ExternalLinkRow href="mailto:support@glance-apps.com" label="support@glance-apps.com" />
            <ExternalLinkRow href="https://github.com/krelltunez/lastGLANCE/issues" label="Report an issue on GitHub" />
          </div>

          <div className="border-t border-slate-100 dark:border-slate-700/40" />

          {/* Build info + shortcuts button */}
          <div className="flex items-end justify-between gap-4">
            <div className="space-y-1">
              {storage && (
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  Storage: {fmtBytes(storage.used)} / ~{fmtBytes(storage.quota)}
                </p>
              )}
              <p className="text-xs text-slate-400 dark:text-slate-500">
                v{__APP_VERSION__} · {buildDate}
              </p>
            </div>
            <button
              onClick={() => { onClose(); onOpenShortcuts() }}
              className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
            >
              <kbd className="inline-flex items-center justify-center w-4 h-4 rounded bg-slate-300 dark:bg-slate-500 text-[10px] font-mono text-slate-600 dark:text-slate-200 leading-none">?</kbd>
              <span className="text-xs text-slate-500 dark:text-slate-400">shortcuts</span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
