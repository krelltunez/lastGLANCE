import { useState, useEffect, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, NotebookText, Download, Search } from 'lucide-react'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'
import { useUsersContext } from '@/multiuser/UsersContext'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { getAllInteractions, getPeople, PEOPLE_CHANGED_EVENT } from '@/people/queries'
import { visibleToMe } from '@/people/home'
import { inRange, visibleInteractions } from '@/people/journal'
import { listFormat } from '@/people/reminders'
import { useShowReciprocity } from '@/people/settings'
import { INTERACTION_CHANNELS, normalizeDirection } from '@/people/types'
import type { Interaction, PersonWithLastInteraction } from '@/people/types'
import { CHANNEL_ICONS, CHANNEL_LABEL_KEYS, DIRECTION_ICONS, DIRECTION_LABEL_KEYS } from '@/components/People/channels'
import { QuickLogSheet } from '@/components/People/QuickLogSheet'
import { saveCsvFile } from '@/utils/exportFile'
import { csvCell, RANGE_KEYS, resolveRange, type RangeKey } from '@/utils/journalRange'
import { formatDayHeading, formatMonthDay, formatTime, getActiveLocale } from '@/utils/datetime'

interface Props {
  onClose: () => void
  // Opens straight to a single day (YYYY-MM-DD), from a heatmap cell.
  initialDate?: string
}

const PAGE_SIZE = 100

// The Journal in People mode: every logged interaction (who, how, who reached
// out, the note) with the same ranges, day grouping and CSV export as the
// chores Journal. Tapping an entry opens it for editing.
export function PeopleJournalModal({ onClose, initialDate }: Props) {
  const { t } = useTranslation()
  const { multiUserEnabled, meId } = useUsersContext()
  const showReciprocity = useShowReciprocity()
  useEscapeKey(onClose)

  const [range, setRange] = useState<RangeKey>(initialDate ? 'custom' : '30d')
  const [customFrom, setCustomFrom] = useState(initialDate ?? '')
  const [customTo, setCustomTo] = useState(initialDate ?? '')
  const [channelFilter, setChannelFilter] = useState<string>('all')
  const [query, setQuery] = useState('')
  const [people, setPeople] = useState<PersonWithLastInteraction[]>([])
  const [all, setAll] = useState<Interaction[]>([])
  const [loading, setLoading] = useState(true)
  const [visible, setVisible] = useState(PAGE_SIZE)
  const [exporting, setExporting] = useState(false)
  const [editing, setEditing] = useState<Interaction | null>(null)

  const load = useCallback(async () => {
    const [p, rows] = await Promise.all([getPeople({ includeArchived: true }), getAllInteractions()])
    setPeople(p)
    setAll(rows)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
    window.addEventListener(PEOPLE_CHANGED_EVENT, load)
    return () => window.removeEventListener(PEOPLE_CHANGED_EVENT, load)
  }, [load])

  const mine = useMemo(() => visibleToMe(people, multiUserEnabled, meId), [people, multiUserEnabled, meId])
  const nameById = useMemo(() => new Map(people.map(p => [p.sync_id, p.nickname || p.name])), [people])
  const originals = useMemo(() => new Map(all.map(i => [i.sync_id, i])), [all])
  const { from, to } = resolveRange(range, customFrom, customTo)

  const entries = useMemo(
    () => visibleInteractions(all, mine).filter(i => inRange(i, from, to)),
    [all, mine, from, to],
  )

  const nameListOf = useCallback(
    (i: Interaction) => i.person_sync_ids.map(id => nameById.get(id)).filter((n): n is string => Boolean(n)),
    [nameById],
  )
  // Display text joins the names the way the language does; the CSV keeps a
  // plain ', ' so the column stays the same in every language.
  const namesOf = useCallback((i: Interaction) => listFormat(getActiveLocale(), nameListOf(i)), [nameListOf])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return entries.filter(i => {
      if (channelFilter !== 'all' && i.channel !== channelFilter) return false
      if (q && !namesOf(i).toLowerCase().includes(q) && !(i.note ?? '').toLowerCase().includes(q)) return false
      return true
    })
  }, [entries, channelFilter, query, namesOf])

  useEffect(() => { setVisible(PAGE_SIZE) }, [range, customFrom, customTo, channelFilter, query])

  const summary = useMemo(() => {
    const who = new Set<string>()
    const perDay = new Map<string, number>()
    for (const i of filtered) {
      for (const id of i.person_sync_ids) who.add(id)
      const day = dayjs(i.occurred_at).format('YYYY-MM-DD')
      perDay.set(day, (perDay.get(day) ?? 0) + 1)
    }
    let busiestDay: string | null = null
    let busiestCount = 0
    for (const [day, count] of perDay) {
      if (count > busiestCount) { busiestDay = day; busiestCount = count }
    }
    return { total: filtered.length, people: who.size, busiestDay, busiestCount }
  }, [filtered])

  const groups = useMemo(() => {
    const out: { day: string; entries: Interaction[] }[] = []
    for (const i of filtered.slice(0, visible)) {
      const day = dayjs(i.occurred_at).format('YYYY-MM-DD')
      const last = out[out.length - 1]
      if (last && last.day === day) last.entries.push(i)
      else out.push({ day, entries: [i] })
    }
    return out
  }, [filtered, visible])

  async function handleExport() {
    if (exporting) return
    setExporting(true)
    try {
      const header = [
        t('journal.csvDate'), t('journal.csvTime'), t('journal.csvPeople'), t('journal.csvHow'),
        t('journal.csvDirection'), t('journal.csvSource'), t('journal.csvNote'),
      ]
      const rows = filtered.map(i => {
        const at = dayjs(i.occurred_at)
        const direction = normalizeDirection(i.direction)
        return [
          at.format('YYYY-MM-DD'),
          at.format('HH:mm'),
          nameListOf(i).join(', '),
          t(CHANNEL_LABEL_KEYS[i.channel]),
          direction ? t(DIRECTION_LABEL_KEYS[direction]) : '',
          i.source,
          i.note ?? '',
        ].map(v => csvCell(String(v))).join(',')
      })
      const csv = [header.map(csvCell).join(','), ...rows].join('\r\n')
      await saveCsvFile(`lastglance-people-journal-${dayjs().format('YYYY-MM-DD')}.csv`, csv)
    } finally {
      setExporting(false)
    }
  }

  const today = dayjs().format('YYYY-MM-DD')
  const yesterday = dayjs().subtract(1, 'day').format('YYYY-MM-DD')
  function dayLabel(day: string): string {
    if (day === today) return t('journal.today')
    if (day === yesterday) return t('journal.yesterday')
    return formatDayHeading(day)
  }

  const hasFilters = channelFilter !== 'all' || query.trim() !== ''
  const field = 'bg-slate-100 dark:bg-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400'

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center app-safe-bottom bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-2xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/50 shadow-2xl rounded-t-2xl sm:rounded-2xl max-h-[90svh] sm:max-h-[85svh] overflow-hidden flex flex-col">

        <div className="flex items-center gap-3 px-5 sm:px-6 pt-5 pb-4 shrink-0 border-b border-slate-100 dark:border-slate-700/40">
          <NotebookText size={18} className="text-green-400 shrink-0" />
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100 flex-1 min-w-0">
            {t('journal.title')}
          </h2>
          <button
            onClick={handleExport}
            disabled={exporting || filtered.length === 0}
            className="flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 disabled:opacity-40 disabled:hover:text-slate-400 transition-colors"
            aria-label={t('journal.exportCsv')}
          >
            <Download size={13} />
            <span className="hidden sm:inline">{t('journal.exportCsv')}</span>
          </button>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors shrink-0"
            aria-label={t('journal.close')}
          >
            <X size={18} />
          </button>
        </div>

        <div className="shrink-0 px-5 sm:px-6 py-3 border-b border-slate-100 dark:border-slate-700/40 space-y-2.5">
          <div className="flex flex-wrap gap-1.5">
            {RANGE_KEYS.map(key => (
              <button
                key={key}
                onClick={() => setRange(key)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                  range === key
                    ? 'text-green-400 border-green-400/40 bg-green-400/10'
                    : 'text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-700 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700/40'
                }`}
                aria-pressed={range === key}
              >
                {t(`journal.range.${key}`)}
              </button>
            ))}
          </div>

          {range === 'custom' && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={customFrom}
                max={customTo || today}
                onChange={e => setCustomFrom(e.target.value)}
                aria-label={t('journal.from')}
                className={`flex-1 min-w-0 ${field} [color-scheme:light] dark:[color-scheme:dark]`}
              />
              <span className="text-xs text-slate-400 dark:text-slate-500 shrink-0">{t('journal.to')}</span>
              <input
                type="date"
                value={customTo}
                min={customFrom || undefined}
                max={today}
                onChange={e => setCustomTo(e.target.value)}
                aria-label={t('journal.to')}
                className={`flex-1 min-w-0 ${field} [color-scheme:light] dark:[color-scheme:dark]`}
              />
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-2 flex-1 min-w-[10rem] bg-slate-100 dark:bg-slate-700 rounded-lg px-2.5 py-1.5 border border-slate-200 dark:border-slate-600 focus-within:ring-2 focus-within:ring-green-400">
              <Search size={12} className="text-slate-400 shrink-0" />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={t('journal.filterPeoplePlaceholder')}
                aria-label={t('journal.filterPeoplePlaceholder')}
                className="flex-1 min-w-0 bg-transparent text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 outline-none"
              />
            </div>
            <select
              value={channelFilter}
              onChange={e => setChannelFilter(e.target.value)}
              aria-label={t('journal.allChannels')}
              className={`${field} px-2`}
            >
              <option value="all">{t('journal.allChannels')}</option>
              {INTERACTION_CHANNELS.map(c => (
                <option key={c} value={c}>{t(CHANNEL_LABEL_KEYS[c])}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="shrink-0 flex divide-x divide-slate-100 dark:divide-slate-700/60 border-b border-slate-100 dark:border-slate-700/40 bg-slate-50 dark:bg-slate-900/60">
          <SummaryCell label={t('journal.statInteractions')} value={String(summary.total)} />
          <SummaryCell label={t('journal.statPeople')} value={String(summary.people)} />
          <SummaryCell
            label={t('journal.statBusiestDay')}
            value={summary.busiestDay ? `${formatMonthDay(summary.busiestDay)} · ${summary.busiestCount}` : '—'}
          />
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 sm:px-6 bg-slate-50 dark:bg-slate-900/60">
          {loading ? (
            <p className="text-sm text-slate-400 dark:text-slate-500 py-10 text-center">{t('journal.loading')}</p>
          ) : filtered.length === 0 ? (
            <div className="py-12 flex flex-col items-center gap-3 text-center">
              <NotebookText size={26} className="text-slate-300 dark:text-slate-600" />
              <p className="text-sm text-slate-400 dark:text-slate-500">
                {hasFilters ? t('journal.emptyFiltered') : t('journal.emptyPeople')}
              </p>
              {hasFilters && (
                <button
                  onClick={() => { setChannelFilter('all'); setQuery('') }}
                  className="text-xs text-green-500 dark:text-green-400 hover:text-green-400 dark:hover:text-green-300 font-medium transition-colors"
                >
                  {t('journal.clearFilters')}
                </button>
              )}
            </div>
          ) : (
            <>
              {groups.map(group => (
                <div key={group.day}>
                  <div className="sticky top-0 z-10 -mx-5 sm:-mx-6 px-5 sm:px-6 flex items-baseline justify-between gap-3 py-2 bg-slate-50 dark:bg-slate-900/95 backdrop-blur-sm">
                    <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500 truncate">
                      {dayLabel(group.day)}
                    </p>
                    <span className="text-xs text-slate-400 dark:text-slate-600 tabular-nums shrink-0">
                      {t('journal.dayCount', { count: group.entries.length })}
                    </span>
                  </div>
                  {group.entries.map(i => {
                    const Icon = CHANNEL_ICONS[i.channel]
                    const direction = normalizeDirection(i.direction)
                    const DirectionIcon = showReciprocity && direction ? DIRECTION_ICONS[direction] : null
                    return (
                      <button
                        key={i.sync_id}
                        onClick={() => setEditing(originals.get(i.sync_id) ?? i)}
                        className="w-full text-left flex items-start gap-3 py-2.5 border-b border-slate-100 dark:border-slate-700/30 hover:bg-slate-100/60 dark:hover:bg-slate-800/60 transition-colors"
                      >
                        <Icon size={14} className="shrink-0 mt-0.5 text-slate-400" />
                        <span className="flex-1 min-w-0">
                          <span className="block text-sm font-medium text-slate-700 dark:text-slate-200 truncate">{namesOf(i)}</span>
                          <span className="flex items-baseline gap-2 flex-wrap text-xs text-slate-400 dark:text-slate-500">
                            <span>{formatTime(i.occurred_at)}</span>
                            <span>{t(CHANNEL_LABEL_KEYS[i.channel])}</span>
                            {DirectionIcon && (
                              <span className="inline-flex items-center gap-0.5">
                                <DirectionIcon size={11} className="shrink-0" />
                                {t(DIRECTION_LABEL_KEYS[direction!])}
                              </span>
                            )}
                          </span>
                          {i.note && <span className="block text-xs text-slate-500 dark:text-slate-400 italic mt-0.5 whitespace-pre-wrap break-words">{i.note}</span>}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))}

              {visible < filtered.length && (
                <div className="py-4 flex justify-center">
                  <button
                    onClick={() => setVisible(v => v + PAGE_SIZE)}
                    className="px-4 py-2 rounded-xl text-xs font-medium text-slate-500 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                  >
                    {t('journal.loadMore', { count: filtered.length - visible })}
                  </button>
                </div>
              )}
              <div className="h-2" />
            </>
          )}
        </div>
      </div>

      {editing && (
        <QuickLogSheet people={mine} interaction={editing} onClose={() => setEditing(null)} />
      )}
    </div>,
    document.body
  )
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex-1 py-2.5 px-3 text-center min-w-0">
      <p className="text-base font-bold text-slate-800 dark:text-slate-100 tabular-nums truncate">{value}</p>
      <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-0.5 truncate">{label}</p>
    </div>
  )
}
