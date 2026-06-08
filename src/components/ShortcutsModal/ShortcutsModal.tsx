import { createPortal } from 'react-dom'
import { X, Keyboard } from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from 'react-i18next'

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
  const { t } = useTranslation()
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-sm text-slate-600 dark:text-slate-300">{label}</span>
      <div className="flex items-center gap-1 shrink-0">
        {keys.map((k, i) => (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && <span className="text-slate-400 dark:text-slate-500 text-xs">{t('shortcuts.or')}</span>}
            <Kbd>{k}</Kbd>
          </span>
        ))}
      </div>
    </div>
  )
}

export function ShortcutsModal({ onClose }: Props) {
  const { t } = useTranslation()
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
            {t('shortcuts.title')}
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
              {t('shortcuts.navigation')}
            </p>
            <div className="divide-y divide-slate-100 dark:divide-slate-700/40">
              <ShortcutRow keys={['⌘K', '/']} label={t('shortcuts.search')} />
              <div className="min-[1060px]:hidden">
                <ShortcutRow keys={['←', '→']} label={t('shortcuts.navigateCategories')} />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div>
            <p className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">
              {t('shortcuts.actions')}
            </p>
            <div className="divide-y divide-slate-100 dark:divide-slate-700/40">
              <ShortcutRow keys={['N']} label={t('shortcuts.newChore')} />
              <ShortcutRow keys={['E']} label={t('shortcuts.toggleEditMode')} />
              <ShortcutRow keys={['M']} label={t('shortcuts.toggleMineAll')} />
              <ShortcutRow keys={['D']} label={t('shortcuts.toggleDarkMode')} />
            </div>
          </div>

          {/* Panels */}
          <div>
            <p className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">
              {t('shortcuts.panels')}
            </p>
            <div className="divide-y divide-slate-100 dark:divide-slate-700/40">
              <ShortcutRow keys={['I']} label={t('shortcuts.integrationSettings')} />
              <ShortcutRow keys={['S']} label={t('shortcuts.syncSettings')} />
              <ShortcutRow keys={['A']} label={t('shortcuts.backupRestore')} />
              <ShortcutRow keys={['L']} label={t('shortcuts.activityLog')} />
              <ShortcutRow keys={['?']} label={t('shortcuts.keyboardShortcuts')} />
            </div>
          </div>

          {/* General */}
          <div>
            <p className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-1">
              {t('shortcuts.general')}
            </p>
            <div className="divide-y divide-slate-100 dark:divide-slate-700/40">
              <ShortcutRow keys={['Esc']} label={t('shortcuts.closeModal')} />
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
