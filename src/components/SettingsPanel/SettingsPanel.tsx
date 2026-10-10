import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import {
  X, Settings, ChevronDown, ChevronRight, Palette, Users, Plug, Archive, Info,
  Sun, Moon, Monitor,
} from 'lucide-react'
import type { SyncEngine } from '@glance-apps/sync'
import type { UseBillingResult } from '@glance-apps/billing/react'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { LanguagePicker } from '@/components/LanguagePicker/LanguagePicker'
import { UsersPanel } from '@/components/UsersPanel/UsersPanel'
import { BackupPanel } from '@/components/BackupModal/BackupModal'
import { HelpContent } from '@/components/HelpModal/HelpModal'
import { SubscriptionStatus } from '@/components/PaywallModal/SubscriptionStatus'
import { formatTimeSample, type TimeFormat } from '@/utils/datetime'

export type ThemePref = 'light' | 'dark' | 'system'

export type SettingsSection = 'appearance' | 'sync' | 'integrations' | 'household' | 'data' | 'about'
type SectionId = SettingsSection

interface Props {
  onClose: () => void
  /** Open on this section, e.g. when coming back from a window launched here. */
  initialSection?: SettingsSection
  themePref: ThemePref
  onThemeChange: (pref: ThemePref) => void
  timeFormat: TimeFormat
  onTimeFormatChange: (pref: TimeFormat) => void
  /** Cloud Sync's live status icon, and whether it is in a failed state. */
  syncIcon: ReactNode
  syncWarn: boolean
  onOpenSync: () => void
  onOpenIntegration: () => void
  onOpenShortcuts: () => void
  engine: SyncEngine | null
  billing: UseBillingResult
  /** A user was added, renamed or removed, or multi-user mode changed. */
  onUserMutated: () => void
  /** A backup restore or sample-data clear replaced the local data. */
  onImported: () => void
}

/**
 * The one settings surface for every screen size: a full-height sheet on
 * phones (no bottom tabs to hang a settings tab on), a centered dialog from
 * sm up. Sections expand one at a time. Everything lives inline except the
 * two heavyweight panels (sync, integration), which keep their own modals and
 * are launched from here.
 */
export function SettingsPanel(props: Props) {
  const { t } = useTranslation()
  const { onClose } = props
  // Back from a window launched here lands on the section it came from. Else
  // sync opens on its own when it needs attention, so the problem is the first
  // thing seen; otherwise the everyday preferences.
  const [open, setOpen] = useState<SectionId | null>(
    props.initialSection ?? (props.syncWarn ? 'sync' : 'appearance'),
  )

  // Escape and Android's Back both close the sheet.
  useEscapeKey(onClose)

  const toggle = (id: SectionId) => setOpen(o => (o === id ? null : id))

  // A fixed afternoon time, so 12- and 24-hour samples visibly differ.
  const sample = '2026-01-01T14:05:00'

  return createPortal(
    <div
      className="fixed inset-0 z-60 flex sm:items-center justify-center sm:p-4 bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        className="w-full h-full sm:h-auto sm:max-w-lg sm:max-h-[85svh] bg-white dark:bg-slate-800 sm:rounded-2xl shadow-2xl sm:border border-slate-200 dark:border-slate-700/50 flex flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:pt-0 sm:pb-0"
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-6 pt-5 pb-4 border-b border-slate-100 dark:border-slate-700/40">
          <Settings size={18} className="text-green-400 shrink-0" />
          <h2 id="settings-title" className="text-base font-semibold text-slate-800 dark:text-slate-100 flex-1">
            {t('settings.title')}
          </h2>
          <button
            onClick={onClose}
            className="p-1 -m-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
            aria-label={t('settings.close')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
          <Section
            id="appearance" open={open} onToggle={toggle}
            icon={<Palette size={16} />} title={t('settings.appearance')}
          >
            <Field label={t('settings.theme')}>
              <Segmented<ThemePref>
                label={t('settings.theme')}
                value={props.themePref}
                onChange={props.onThemeChange}
                options={[
                  { value: 'light', label: t('settings.themeLight'), icon: <Sun size={14} /> },
                  { value: 'dark', label: t('settings.themeDark'), icon: <Moon size={14} /> },
                  { value: 'system', label: t('settings.themeSystem'), icon: <Monitor size={14} /> },
                ]}
              />
            </Field>
            <Field label={t('app.language')} htmlFor="settings-language">
              <LanguagePicker
                id="settings-language"
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
            </Field>
            <Field label={t('settings.timeFormat')}>
              <Segmented<TimeFormat>
                label={t('settings.timeFormat')}
                value={props.timeFormat}
                onChange={props.onTimeFormatChange}
                options={[
                  { value: 'auto', label: t('settings.timeAuto') },
                  { value: '12', label: formatTimeSample(sample, '12') },
                  { value: '24', label: formatTimeSample(sample, '24') },
                ]}
              />
              <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">
                {t('settings.timeAutoHint', { example: formatTimeSample(sample, 'auto') })}
              </p>
            </Field>
          </Section>

          <Section
            id="sync" open={open} onToggle={toggle}
            icon={props.syncIcon} title={t('app.cloudSync')} warn={props.syncWarn}
            summary={props.syncWarn ? t('settings.syncAttention') : undefined}
          >
            <Description>{t('settings.syncDesc')}</Description>
            <LinkRow icon={props.syncIcon} label={t('app.cloudSync')} onClick={props.onOpenSync} />
          </Section>

          <Section
            id="integrations" open={open} onToggle={toggle}
            icon={<Plug size={16} />} title={t('settings.integrations')}
          >
            <Description>{t('settings.integrationsDesc')}</Description>
            <LinkRow icon={<Plug size={15} />} label={t('app.dayglanceIntegration')} onClick={props.onOpenIntegration} />
          </Section>

          <Section
            id="household" open={open} onToggle={toggle}
            icon={<Users size={16} />} title={t('settings.household')}
          >
            <UsersPanel engine={props.engine} onUserMutated={props.onUserMutated} />
          </Section>

          <Section
            id="data" open={open} onToggle={toggle}
            icon={<Archive size={16} />} title={t('app.backupRestore')}
          >
            {/* A finished restore replaced everything behind this panel, so it
                closes to show the result. */}
            <BackupPanel engine={props.engine} onImported={props.onImported} onDone={onClose} />
          </Section>

          <Section
            id="about" open={open} onToggle={toggle}
            icon={<Info size={16} />} title={t('settings.about')}
            summary={`v${__APP_VERSION__}`}
          >
            <SubscriptionStatus billing={props.billing} />
            <div className="border-t border-slate-100 dark:border-slate-700/40" />
            <HelpContent onOpenShortcuts={props.onOpenShortcuts} />
          </Section>
        </div>
      </div>
    </div>,
    document.body,
  )
}

function Section({ id, open, onToggle, icon, title, summary, warn, children }: {
  id: SectionId
  open: SectionId | null
  onToggle: (id: SectionId) => void
  icon: ReactNode
  title: string
  summary?: string
  warn?: boolean
  children: ReactNode
}) {
  const expanded = open === id
  const bodyId = `settings-section-${id}`
  return (
    <div className="border-b border-slate-100 dark:border-slate-700/40 last:border-b-0">
      <button
        onClick={() => onToggle(id)}
        aria-expanded={expanded}
        aria-controls={bodyId}
        className="w-full flex items-center gap-3 px-3 py-3 rounded-lg text-left hover:bg-slate-50 dark:hover:bg-slate-700/40 transition-colors"
      >
        <span className={`shrink-0 ${warn ? 'text-amber-400' : 'text-slate-400 dark:text-slate-500'}`}>{icon}</span>
        <span className="flex-1 min-w-0 text-sm font-medium text-slate-700 dark:text-slate-200">{title}</span>
        {summary && !expanded && (
          <span className={`text-xs truncate ${warn ? 'text-amber-400' : 'text-slate-400 dark:text-slate-500'}`}>{summary}</span>
        )}
        <ChevronDown
          size={16}
          className={`shrink-0 text-slate-400 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      {expanded && (
        <div id={bodyId} className="px-3 pb-4 pt-1 space-y-4">
          {children}
        </div>
      )}
    </div>
  )
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  const cls = 'block mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500'
  return (
    <div>
      {htmlFor
        ? <label htmlFor={htmlFor} className={cls}>{label}</label>
        : <div className={cls}>{label}</div>}
      {children}
    </div>
  )
}

function Description({ children }: { children: ReactNode }) {
  return <p className="text-sm text-slate-500 dark:text-slate-400">{children}</p>
}

function LinkRow({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-700 text-sm text-left text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
    >
      <span className="shrink-0">{icon}</span>
      <span className="flex-1 min-w-0">{label}</span>
      <ChevronRight size={15} className="shrink-0 text-slate-400" />
    </button>
  )
}

function Segmented<T extends string>({ label, value, onChange, options }: {
  label: string
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string; icon?: ReactNode }[]
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 gap-0.5">
      {options.map(o => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className={`flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors ${
              selected
                ? 'bg-green-400/15 text-green-500 dark:text-green-400 font-medium'
                : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
            }`}
          >
            {o.icon}
            <span className="truncate">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
