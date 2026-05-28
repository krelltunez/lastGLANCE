import { createPortal } from 'react-dom'
import { X, Keyboard } from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'

interface Props {
  onClose: () => void
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 border border-slate-300 dark:border-slate-600 text-[11px] font-mono text-slate-600 dark:text-slate-300 leading-none">
      {children}
    </kbd>
  )
}

interface ShortcutRowProps {
  keys: React.ReactNode[]
  label: string
}

function ShortcutRow({ keys, label }: ShortcutRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm text-slate-600 dark:text-slate-300">{label}</span>
      <div className="flex items-center gap-1 shrink-0">
        {keys.map((k, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-slate-400 dark:text-slate-500 text-xs">or</span>}
            <Kbd>{k}</Kbd>
          </span>
        ))}
      </div>
    </div>
  )
}

export function ShortcutsModal({ onClose }: Props) {
  useEscapeKey(onClose)

  return createPortal(
    <div
      className="fixed inset-0 z-60 flex items-end sm:items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-sm bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/50 flex flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 pt-5 pb-4 border-b border-slate-100 dark:border-slate-700/40">
          <Keyboard size={18} className="text-green-400 shrink-0" />
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100 flex-1">
            Keyboard Shortcuts
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          {/* Navigation */}
          <div>
            <p className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">
              Navigation
            </p>
            <div className="divide-y divide-slate-100 dark:divide-slate-700/40">
              <ShortcutRow keys={['⌘K', '/']} label="Search" />
              <div className="min-[1060px]:hidden">
                <ShortcutRow keys={['←', '→']} label="Navigate categories" />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div>
            <p className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">
              Actions
            </p>
            <div className="divide-y divide-slate-100 dark:divide-slate-700/40">
              <ShortcutRow keys={['N']} label="New chore" />
              <ShortcutRow keys={['E']} label="Toggle edit mode" />
              <ShortcutRow keys={['D']} label="Toggle dark mode" />
            </div>
          </div>

          {/* Panels */}
          <div>
            <p className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">
              Panels
            </p>
            <div className="divide-y divide-slate-100 dark:divide-slate-700/40">
              <ShortcutRow keys={['I']} label="Integration settings" />
              <ShortcutRow keys={['S']} label="Sync settings" />
              <ShortcutRow keys={['A']} label="Backup &amp; Restore" />
              <ShortcutRow keys={['L']} label="Activity log" />
              <ShortcutRow keys={['?']} label="Keyboard shortcuts" />
            </div>
          </div>

          {/* General */}
          <div>
            <p className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">
              General
            </p>
            <div className="divide-y divide-slate-100 dark:divide-slate-700/40">
              <ShortcutRow keys={['Esc']} label="Close modal" />
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
