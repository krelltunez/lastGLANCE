import { useState, useEffect, useRef } from 'react'
import { X, Trash2, NotebookPen } from 'lucide-react'
import dayjs from 'dayjs'
import type { ChoreWithLastCompletion, CompletionEvent } from '@/types'
import { logCompletion, getCompletionHistory, deleteCompletion, updateCompletionNote } from '@/db/queries'
import { getMeUserSyncId } from '@/multiuser/settings'
import { useUsersContext } from '@/multiuser/UsersContext'
import { formatElapsed } from '@/utils/cadence'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { DateTimePicker } from '@/components/DateTimePicker/DateTimePicker'
import { useIntents } from '@/intents/IntentsContext'
import { emitCreateIntent } from '@/intents/emitter'
import { useTranslation } from 'react-i18next'

interface Props {
  chore: ChoreWithLastCompletion
  onClose: () => void
  onLogged: () => void
}

type SendState = 'idle' | 'saving' | 'done' | 'error'

export function LogModal({ chore, onClose, onLogged }: Props) {
  const { t } = useTranslation()
  const { users, multiUserEnabled } = useUsersContext()
  const { isConfigured } = useIntents()
  const [note, setNote] = useState('')
  const [backdateDate, setBackdateDate] = useState('')
  const [backdateTime, setBackdateTime] = useState('')
  const [saving, setSaving] = useState(false)
  const [sendState, setSendState] = useState<SendState>('idle')
  const [completions, setCompletions] = useState<CompletionEvent[]>([])
  const heatmapRef = useRef<HTMLDivElement>(null)
  useEscapeKey(onClose)

  useEffect(() => {
    getCompletionHistory(chore.id, 1000).then(c => setCompletions(c))
  }, [chore.id])

  useEffect(() => {
    if (!heatmapRef.current) return
    const id = requestAnimationFrame(() => {
      if (heatmapRef.current)
        heatmapRef.current.scrollLeft = heatmapRef.current.scrollWidth
    })
    return () => cancelAnimationFrame(id)
  }, [completions])

  async function handleLog() {
    setSaving(true)
    try {
      await logCompletion(chore.id, {
        note: note.trim() || undefined,
        completedAt: backdateDate
          ? dayjs(backdateTime ? `${backdateDate}T${backdateTime}` : `${backdateDate}T12:00`).toISOString()
          : undefined,
        completedByUserSyncId: getMeUserSyncId(),
      })
      onLogged()
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(id: number) {
    await deleteCompletion(id)
    const updated = await getCompletionHistory(chore.id, 1000)
    setCompletions(updated)
  }

  async function handleSendToDayGlance() {
    if (sendState !== 'idle') return
    setSendState('saving')
    try {
      const ok = await emitCreateIntent(chore)
      setSendState(ok ? 'done' : 'error')
      setTimeout(() => setSendState('idle'), 2000)
    } catch {
      setSendState('error')
      setTimeout(() => setSendState('idle'), 2000)
    }
  }

  const elapsedText = formatElapsed(chore.elapsed_days, chore.last_completed_at)
  const stats = computeStats(completions)
  const heatmap = buildHeatmap(completions)

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center app-safe-bottom bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="
        w-full bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/50 shadow-2xl
        rounded-t-2xl max-h-[90svh] overflow-hidden flex flex-col
        sm:rounded-2xl sm:max-w-xl
        lg:max-w-5xl lg:max-h-[85svh] lg:flex-row
      ">

        {/* ── Left / top: log form ── */}
        <div className="flex flex-col p-6 gap-4 overflow-y-auto min-h-0 lg:w-72 lg:shrink-0 lg:border-r lg:border-slate-100 dark:lg:border-slate-700/60 lg:self-stretch">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">{chore.name}</h2>
              <p className="text-sm text-slate-400 dark:text-slate-400 mt-0.5">{t('logModal.lastDone', { elapsed: elapsedText })}</p>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors shrink-0 mt-0.5">
              <X size={18} />
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('logModal.noteLabel')}</label>
              <input
                type="text"
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder={t('logModal.notePlaceholder')}
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">{t('logModal.backdateLabel')}</label>
              <DateTimePicker
                date={backdateDate}
                time={backdateTime}
                onDateChange={setBackdateDate}
                onTimeChange={setBackdateTime}
                maxDate={dayjs().format('YYYY-MM-DD')}
              />
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
            >
              {t('logModal.cancel')}
            </button>
            <button
              onClick={handleLog}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-green-400 border border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60 disabled:opacity-50 transition-colors"
            >
              {saving ? t('logModal.logging') : t('logModal.logDone')}
            </button>
          </div>

          {isConfigured && (
            <button
              onClick={handleSendToDayGlance}
              disabled={sendState !== 'idle'}
              className={`w-full py-2 rounded-xl text-sm font-medium border transition-colors disabled:opacity-50 ${
                sendState === 'done'
                  ? 'text-green-400 border-green-400/40 bg-green-400/10'
                  : sendState === 'error'
                  ? 'text-red-400 border-red-400/40 bg-red-400/10'
                  : 'text-blue-400 border-blue-400/40 hover:text-blue-300 hover:bg-blue-400/10 hover:border-blue-400/60'
              }`}
            >
              {sendState === 'done' ? t('logModal.sendDone') : sendState === 'error' ? t('logModal.sendError') : t('logModal.sendLabel')}
            </button>
          )}
        </div>

        {/* ── Right / bottom: history ── */}
        <div className="flex-1 min-w-0 flex flex-col min-h-0 border-t border-slate-100 dark:border-slate-700/60 lg:border-t-0 bg-slate-50 dark:bg-slate-900/60">

          <div className="shrink-0 flex divide-x divide-slate-100 dark:divide-slate-700/60 border-b border-slate-100 dark:border-slate-700/60">
            <StatCell label={t('logModal.statTotal')} value={String(completions.length)} />
            <StatCell label={t('logModal.statAvgInterval')} value={stats.avgInterval} />
            <StatCell label={t('logModal.statTarget')} value={chore.target_cadence_days ? t('logModal.targetDays', { n: chore.target_cadence_days }) : t('logModal.noTarget')} />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto">
            <div className="px-5 pt-4 pb-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-3">{t('logModal.pastYear')}</p>
              <div ref={heatmapRef} className="overflow-x-auto scrollbar-none">
                <Heatmap weeks={heatmap} />
              </div>
            </div>

            <div className="px-5 pb-6">
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-2">
                {completions.length > 0 ? t('logModal.historyWithCount', { count: completions.length }) : t('logModal.history')}
              </p>
              {completions.length === 0 ? (
                <p className="text-sm text-slate-400 dark:text-slate-600 py-4 text-center">{t('logModal.noCompletions')}</p>
              ) : (
                <div>
                  {completions.map((evt, i) => {
                    const prev = completions[i + 1]
                    const gapDays = prev
                      ? dayjs(evt.completed_at).diff(dayjs(prev.completed_at), 'day')
                      : null
                    return (
                      <div key={evt.id}>
                        <CompletionRow
                          evt={evt}
                          onDelete={() => handleDelete(evt.id)}
                          onEditNote={async (note) => {
                            await updateCompletionNote(evt.id, note)
                            setCompletions(prev => prev.map(c => c.id === evt.id ? { ...c, note } : c))
                          }}
                          userName={multiUserEnabled && evt.completed_by_user_sync_id
                            ? (users.find(u => u.sync_id === evt.completed_by_user_sync_id)?.name ?? null)
                            : null}
                        />
                        {gapDays !== null && gapDays > 0 && (
                          <GapMarker days={gapDays} target={chore.target_cadence_days} />
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex-1 py-3 px-4 text-center min-w-0">
      <p className="text-lg font-bold text-slate-800 dark:text-slate-100 tabular-nums truncate">{value}</p>
      <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 truncate">{label}</p>
    </div>
  )
}

function CompletionRow({ evt, onDelete, onEditNote, userName }: { evt: CompletionEvent; onDelete: () => void; onEditNote: (note: string | null) => void; userName: string | null }) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const [editingNote, setEditingNote] = useState(false)
  const [noteValue, setNoteValue] = useState(evt.note ?? '')
  const noteInputRef = useRef<HTMLInputElement>(null)
  const dt = dayjs(evt.completed_at)

  function openNoteEdit() {
    setNoteValue(evt.note ?? '')
    setEditingNote(true)
    setTimeout(() => noteInputRef.current?.focus(), 0)
  }

  function saveNote() {
    onEditNote(noteValue.trim() || null)
    setEditingNote(false)
  }

  function cancelNote() {
    setNoteValue(evt.note ?? '')
    setEditingNote(false)
  }

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-slate-100 dark:border-slate-700/30 group">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{dt.format('MMM D, YYYY')}</span>
          <span className="text-xs text-slate-400 dark:text-slate-500">{dt.format('h:mm A')}</span>
          {userName && (
            <span className="text-xs text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-700/60 px-1.5 py-0.5 rounded">{userName}</span>
          )}
          {evt.source === 'dayglance' && (
            <span className="text-xs text-blue-500 dark:text-blue-400 bg-blue-50 dark:bg-blue-400/10 px-1.5 py-0.5 rounded">{t('logModal.viaDayglance')}</span>
          )}
        </div>
        {editingNote ? (
          <div className="flex items-center gap-2 mt-1">
            <input
              ref={noteInputRef}
              type="text"
              value={noteValue}
              onChange={e => setNoteValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') saveNote(); if (e.key === 'Escape') cancelNote() }}
              placeholder={t('logModal.addNotePlaceholder')}
              className="flex-1 bg-slate-100 dark:bg-slate-700 rounded px-2 py-1 text-xs text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
            />
            <button onClick={cancelNote} className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 shrink-0">{t('logModal.cancel')}</button>
            <button onClick={saveNote} className="text-xs text-green-500 hover:text-green-400 font-medium shrink-0">{t('logModal.saveNote')}</button>
          </div>
        ) : (
          evt.note && <p className="text-xs text-slate-400 dark:text-slate-400 italic mt-0.5">{evt.note}</p>
        )}
      </div>
      {!editingNote && (confirming ? (
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setConfirming(false)} className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">{t('logModal.cancel')}</button>
          <button onClick={onDelete} className="text-xs text-red-500 hover:text-red-400 font-medium">{t('logModal.delete')}</button>
        </div>
      ) : (
        <div className="flex items-center gap-2.5 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
          <button
            onClick={openNoteEdit}
            className="text-slate-300 dark:text-slate-700 hover:text-green-400 transition-colors"
          >
            <NotebookPen size={15} />
          </button>
          <button
            onClick={() => setConfirming(true)}
            className="text-slate-300 dark:text-slate-700 hover:text-red-400 transition-colors"
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
    </div>
  )
}

function GapMarker({ days, target }: { days: number; target: number | null }) {
  const { t } = useTranslation()
  const overdue = target !== null && days > target
  return (
    <div className="flex items-center gap-2 py-1 pl-2">
      <div className={`w-px h-4 rounded-full ${overdue ? 'bg-red-300 dark:bg-red-800' : 'bg-slate-200 dark:bg-slate-700'}`} />
      <span className={`text-xs tabular-nums ${overdue ? 'text-red-400 dark:text-red-500' : 'text-slate-400 dark:text-slate-600'}`}>
        {t('logModal.daysLater', { count: days })}
      </span>
    </div>
  )
}

// ── Heatmap ───────────────────────────────────────────────────────────────────

type HeatDay = { date: string; count: number; isFuture: boolean }

function Heatmap({ weeks }: { weeks: HeatDay[][] }) {
  const today = dayjs().format('YYYY-MM-DD')
  const months = getMonthLabels(weeks)
  const DAY_LABELS = ['', 'M', '', 'W', '', 'F', '']

  return (
    <div className="inline-flex flex-col gap-1 select-none">
      <div className="flex gap-[3px] mb-0.5 ml-5">
        {weeks.map((_w, wi) => (
          <div key={wi} className="w-[11px] text-[9px] text-slate-400 dark:text-slate-600 text-center leading-none">
            {months.get(wi) ?? ''}
          </div>
        ))}
      </div>
      <div className="flex gap-[3px]">
        <div className="flex flex-col gap-[3px] mr-1">
          {DAY_LABELS.map((l, i) => (
            <div key={i} className="h-[11px] w-3 text-[9px] text-slate-400 dark:text-slate-600 text-right leading-[11px]">{l}</div>
          ))}
        </div>
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {week.map((day, di) => (
              <div
                key={di}
                title={day.isFuture ? '' : `${day.date}${day.count > 0 ? ` · ${day.count}` : ''}`}
                className="w-[11px] h-[11px] rounded-[2px]"
                style={{ backgroundColor: cellColor(day, today) }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function cellColor(day: HeatDay, today: string): string {
  if (day.isFuture) return 'transparent'
  if (day.date === today && day.count === 0) return '#1e3a2f'
  if (day.count === 0) return '#2d3f55'
  if (day.count === 1) return '#16a34a'
  return '#4ade80'
}

function getMonthLabels(weeks: HeatDay[][]): Map<number, string> {
  const labels = new Map<number, string>()
  let last = -1
  weeks.forEach((week, wi) => {
    const m = dayjs(week[0].date).month()
    if (m !== last) { labels.set(wi, dayjs(week[0].date).format('MMM')); last = m }
  })
  return labels
}

function buildHeatmap(completions: CompletionEvent[]): HeatDay[][] {
  const byDate = new Map<string, number>()
  for (const c of completions) {
    const d = dayjs(c.completed_at).format('YYYY-MM-DD')
    byDate.set(d, (byDate.get(d) ?? 0) + 1)
  }
  const today = dayjs()
  const start = today.subtract(51, 'week').startOf('week')
  const weeks: HeatDay[][] = []
  let cur = start
  for (let w = 0; w < 52; w++) {
    const week: HeatDay[] = []
    for (let d = 0; d < 7; d++) {
      const date = cur.format('YYYY-MM-DD')
      week.push({ date, count: byDate.get(date) ?? 0, isFuture: cur.isAfter(today) })
      cur = cur.add(1, 'day')
    }
    weeks.push(week)
  }
  return weeks
}

function computeStats(completions: CompletionEvent[]) {
  if (completions.length < 2) return { avgInterval: '—' }
  const gaps = completions.slice(0, -1).map((c, i) =>
    dayjs(c.completed_at).diff(dayjs(completions[i + 1].completed_at), 'day')
  )
  const avg = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)
  return { avgInterval: avg === 1 ? '1 day' : `${avg}d` }
}
