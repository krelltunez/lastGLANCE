import { useEffect, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Check, ChevronRight, Plus } from 'lucide-react'
import dayjs from 'dayjs'
import type { DesktopTray, DesktopTrayChore, DesktopTrayDate, DesktopTrayPerson, DesktopTrayState } from '@/native/desktop'
import { ICON_REGISTRY } from '@/icons/registry'
import { formatElapsed, formatNextDue } from '@/utils/cadence'
import { formatMonthShort } from '@/utils/datetime'
import { daysUntilLabel } from '@/components/People/labels'

// The desktop tray popup (docs/desktop-app.md, section 7): a widget, drawn
// with the app's own cards. It renders what main derives from the widget
// snapshot the main window pushes, and never opens the database or runs a
// sync engine. "Done" queues a completion for the main window to apply
// (electron/commandQueue.ts); main hides the chore once the next snapshot
// shows it. People's Log opens the app's quick-log sheet, which needs the
// window.

type Mode = 'chores' | 'people'
const MODE_KEY = 'lg_tray_mode'
// How long a card shows "Logged!" before the completion goes to main.
const DONE_FLASH_MS = 700

function readMode(): Mode {
  try { return localStorage.getItem(MODE_KEY) === 'people' ? 'people' : 'chores' } catch { return 'chores' }
}

export function TrayPopup({ tray }: { tray: DesktopTray }) {
  const { t } = useTranslation()
  const [state, setState] = useState<DesktopTrayState | null>(null)
  const [mode, setModeState] = useState<Mode>(readMode)
  const setMode = (m: Mode) => {
    setModeState(m)
    try { localStorage.setItem(MODE_KEY, m) } catch { /* per-window convenience */ }
  }

  useEffect(() => {
    let live = true
    tray.state().then((s) => { if (live && s) setState(s) }).catch(() => {})
    const off = tray.onState((s) => setState(s as DesktopTrayState))
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') tray.hide() }
    window.addEventListener('keydown', onKey)
    return () => { live = false; off(); window.removeEventListener('keydown', onKey) }
  }, [tray])

  const due = state?.counts.overdue ?? 0

  return (
    <div className="h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100 select-none">
      <header className="shrink-0 px-4 pt-4 pb-3 border-b border-slate-200 dark:border-slate-800/80 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-black tracking-tight leading-none text-slate-900 dark:text-slate-100">
            last<span className="italic text-green-400">GLANCE</span>
          </h1>
          <p className="text-[11px] text-slate-400 dark:text-slate-600 mt-1 tracking-wide truncate">{t('app.tagline')}</p>
        </div>
        <div className="inline-flex shrink-0 p-0.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-900" role="tablist">
          {(['chores', 'people'] as const).map((m) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
                mode === m
                  ? 'bg-white dark:bg-slate-800 text-green-500 dark:text-green-400 shadow-sm'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
              }`}
            >
              {m === 'chores' ? t('app.modeChores') : t('app.modePeople')}
              {m === 'chores' && due > 0 && (
                <span className="ml-1.5 inline-flex min-w-4 h-4 px-1 items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold tabular-nums">{due}</span>
              )}
            </button>
          ))}
        </div>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        {state && !state.ready && <Empty text={t('tray.notReady')} />}
        {state?.ready && mode === 'chores' && <ChoresPane state={state} tray={tray} />}
        {state?.ready && mode === 'people' && <PeoplePane state={state} tray={tray} />}
      </main>

      <button
        onClick={() => tray.open(mode === 'people' ? 'people' : null)}
        className="shrink-0 flex items-center justify-center gap-1 px-4 py-2.5 text-sm font-medium text-green-600 dark:text-green-400 border-t border-slate-200 dark:border-slate-800/80 hover:bg-white dark:hover:bg-slate-900 transition-colors"
      >
        {t('tray.open')}
        <ChevronRight size={14} />
      </button>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return <p className="px-2 py-8 text-sm text-slate-400 dark:text-slate-500 text-center">{text}</p>
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="px-1 mb-2 text-sm font-bold text-green-400 tracking-tight">{children}</h2>
}

function ChoresPane({ state, tray }: { state: DesktopTrayState; tray: DesktopTray }) {
  const { t } = useTranslation()
  if (state.due.length === 0) return <Empty text={t('tray.nothingDue')} />
  return (
    <div className="space-y-2">
      {state.due.map((c) => <ChoreCard key={c.syncId} chore={c} tray={tray} />)}
    </div>
  )
}

// The app's chore card (src/components/ChoreRow/ChoreRow.tsx), read-only:
// the cadence stripe and fill, the icon in the cadence colour, and Done.
function ChoreCard({ chore, tray }: { chore: DesktopTrayChore; tray: DesktopTray }) {
  const { t } = useTranslation()
  const [done, setDone] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const ratio = chore.ratio
  const color = chore.color ?? '#64748b'
  const width = ratio !== null ? `${Math.min(ratio * 100, 100)}%` : '0%'
  const elapsed = formatElapsed(t, chore.elapsedDays, chore.lastCompletedAt)
  const nextDue = formatNextDue(t, chore.targetCadenceDays, chore.elapsedDays, chore.lastCompletedAt)
  const Icon = chore.icon ? ICON_REGISTRY[chore.icon] : null

  const markDone = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (done) return
    setDone(true)
    timer.current = setTimeout(() => tray.complete(chore.syncId), DONE_FLASH_MS)
  }

  return (
    <div
      role="button"
      onClick={() => tray.open(`chore:${chore.syncId}`)}
      className="relative overflow-hidden rounded-xl bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/40 cursor-pointer group transition-colors hover:border-slate-300 dark:hover:border-slate-600/60"
    >
      <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: color, opacity: ratio !== null ? 0.9 : 0.3 }} />
      <div className="absolute inset-y-0 left-0" style={{ width, backgroundColor: color, opacity: 0.1 }} />
      <div className="relative flex items-center gap-3 pl-4 pr-3 py-3">
        {Icon && <Icon size={20} className="shrink-0" style={{ color: ratio !== null ? color : '#94a3b8' }} />}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{chore.name}</p>
          <p className="text-xs text-slate-400 dark:text-slate-500 tabular-nums mt-0.5 truncate">
            {chore.categoryName && <span className="text-slate-500 dark:text-slate-400">{chore.categoryName} · </span>}
            {nextDue
              ? <Trans i18nKey="nextDue.combined" values={{ elapsed, due: nextDue }} components={{ 1: <span className="italic" /> }} />
              : elapsed}
          </p>
        </div>
        <button
          onClick={markDone}
          aria-label={t('choreRow.quickLogAriaLabel', { name: chore.name })}
          className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 border ${
            done
              ? 'bg-green-500/20 border-green-500/40 text-green-500 dark:text-green-400'
              : 'bg-slate-100 dark:bg-slate-700/60 border-slate-200 dark:border-slate-600/40 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 hover:bg-slate-200 dark:hover:bg-slate-700 hover:border-slate-300 dark:hover:border-slate-500/60'
          }`}
        >
          <Check size={12} strokeWidth={2.5} />
          <span>{done ? t('choreRow.logDone') : t('choreRow.logIdle')}</span>
        </button>
      </div>
    </div>
  )
}

function PeoplePane({ state, tray }: { state: DesktopTrayState; tray: DesktopTray }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <section>
        <SectionTitle>{t('people.home.reachOut')}</SectionTitle>
        {state.reachOut.length
          ? <div className="space-y-2">{state.reachOut.map((p) => <PersonCard key={p.syncId} person={p} tray={tray} />)}</div>
          : <p className="px-1 text-sm text-slate-400 dark:text-slate-500">{t('people.home.reachOutEmpty')}</p>}
      </section>
      <section>
        <SectionTitle>{t('people.home.comingUp')}</SectionTitle>
        {state.comingUp.length
          ? <div className="grid grid-cols-3 gap-2">{state.comingUp.slice(0, 3).map((d) => <DateTile key={`${d.personSyncId}-${d.on}-${d.label}`} date={d} tray={tray} />)}</div>
          : <p className="px-1 text-sm text-slate-400 dark:text-slate-500">{t('people.home.comingUpEmpty')}</p>}
      </section>
    </div>
  )
}

// The app's Reach out card (src/components/People/PersonRow.tsx): the cadence
// stripe and fill, the initial, the reason line, and Log, which opens the
// app's quick-log sheet for the person.
function PersonCard({ person, tray }: { person: DesktopTrayPerson; tray: DesktopTray }) {
  const { t } = useTranslation()
  const width = person.ratio !== null ? `${Math.min(person.ratio * 100, 100)}%` : '0%'
  return (
    <div
      role="button"
      onClick={() => tray.open(`person:${person.syncId}`)}
      className="relative overflow-hidden rounded-xl bg-white dark:bg-slate-800/80 border border-slate-200 dark:border-slate-700/40 cursor-pointer transition-colors hover:border-slate-300 dark:hover:border-slate-600/60"
    >
      <div className="absolute inset-y-0 left-0 w-1 rounded-l-xl" style={{ backgroundColor: person.color, opacity: 0.9 }} />
      <div className="absolute inset-y-0 left-0" style={{ width, backgroundColor: person.color, opacity: 0.1 }} />
      <div className="relative flex items-center gap-3 pl-4 pr-3 py-2.5">
        <span className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-300" aria-hidden>
          {person.name.charAt(0).toUpperCase()}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{person.name}</p>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 truncate">{person.detail}</p>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); tray.open(`log:${person.syncId}`) }}
          aria-label={t('people.row.logAriaLabel', { name: person.name })}
          className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium border bg-slate-100 dark:bg-slate-700/60 border-slate-200 dark:border-slate-600/40 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
        >
          <Plus size={12} strokeWidth={2.5} />
          <span>{t('people.row.log')}</span>
        </button>
      </div>
    </div>
  )
}

// The app's Coming up tile (PeopleHome's DateTile), counted from today so a
// tile stays right across midnight without a fresh snapshot.
function DateTile({ date, tray }: { date: DesktopTrayDate; tray: DesktopTray }) {
  const { t } = useTranslation()
  const on = dayjs(date.on)
  const daysUntil = Math.max(0, on.startOf('day').diff(dayjs().startOf('day'), 'day'))
  const soon = daysUntil <= 7
  return (
    <button
      onClick={() => tray.open(`person:${date.personSyncId}`)}
      className={`aspect-square min-w-0 flex flex-col justify-between rounded-xl border p-2.5 text-left transition-colors ${
        soon
          ? 'bg-pink-400/10 border-pink-400/40 hover:border-pink-400/70'
          : 'bg-white dark:bg-slate-800/80 border-slate-200 dark:border-slate-700/40 hover:border-slate-300 dark:hover:border-slate-600/60'
      }`}
    >
      <span className="flex items-start justify-between gap-1">
        <span className="flex flex-col leading-none">
          <span className={`text-xl font-bold tabular-nums ${soon ? 'text-pink-400' : 'text-slate-700 dark:text-slate-200'}`}>{on.date()}</span>
          <span className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-400 dark:text-slate-500">{formatMonthShort(on)}</span>
        </span>
        <span className="text-[10px] text-slate-400 dark:text-slate-500 tabular-nums shrink-0 mt-0.5">{daysUntilLabel(t, daysUntil)}</span>
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-medium text-slate-800 dark:text-slate-100 leading-tight line-clamp-2 break-words">{date.name}</span>
        <span className="block text-[10px] text-slate-400 dark:text-slate-500 truncate mt-0.5">{date.label}</span>
      </span>
    </button>
  )
}
