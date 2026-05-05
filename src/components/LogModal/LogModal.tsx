import { useState, useEffect, useRef } from 'react'
import { X, Trash2 } from 'lucide-react'
import dayjs from 'dayjs'
import type { ChoreWithLastCompletion, CompletionEvent } from '@/types'
import { logCompletion, getCompletionHistory, deleteCompletion } from '@/db/queries'
import { formatElapsed } from '@/utils/cadence'

interface Props {
  chore: ChoreWithLastCompletion
  onClose: () => void
  onLogged: () => void
}

export function LogModal({ chore, onClose, onLogged }: Props) {
  const [note, setNote] = useState('')
  const [backdate, setBackdate] = useState('')
  const [saving, setSaving] = useState(false)
  const [completions, setCompletions] = useState<CompletionEvent[]>([])
  const heatmapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    getCompletionHistory(chore.id, 1000).then(c => {
      setCompletions(c)
    })
  }, [chore.id])

  useEffect(() => {
    if (heatmapRef.current) {
      heatmapRef.current.scrollLeft = heatmapRef.current.scrollWidth
    }
  }, [completions])

  async function handleLog() {
    setSaving(true)
    try {
      await logCompletion(chore.id, {
        note: note.trim() || undefined,
        completedAt: backdate ? dayjs(backdate).toISOString() : undefined,
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

  const elapsedText = formatElapsed(chore.elapsed_days, chore.last_completed_at)
  const stats = computeStats(completions)
  const heatmap = buildHeatmap(completions)

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      {/*
        Mobile:  tall bottom sheet, single column, scrollable
        Desktop: wide centered modal, two columns
      */}
      <div className="
        w-full bg-slate-800 border border-slate-700/50 shadow-2xl
        rounded-t-2xl max-h-[90svh] overflow-hidden flex flex-col
        sm:rounded-2xl sm:max-w-xl
        lg:max-w-4xl lg:max-h-[85svh] lg:flex-row
      ">

        {/* ── Left / top: log form ────────────────────────────────── */}
        <div className="shrink-0 flex flex-col p-6 gap-4 lg:w-80 lg:border-r lg:border-slate-700/60">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h2 className="text-base font-semibold text-slate-100">{chore.name}</h2>
              <p className="text-sm text-slate-400 mt-0.5">Last done: {elapsedText}</p>
            </div>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-200 transition-colors shrink-0 mt-0.5">
              <X size={18} />
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Note (optional)</label>
              <input
                type="text"
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="e.g. only the front bathroom"
                className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 border border-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">Done earlier? (optional)</label>
              <input
                type="datetime-local"
                value={backdate}
                onChange={e => setBackdate(e.target.value)}
                max={dayjs().format('YYYY-MM-DDTHH:mm')}
                className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 border border-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-400"
              />
            </div>
          </div>

          <div className="flex gap-3 mt-auto">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-300 bg-slate-700 hover:bg-slate-600 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleLog}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-900 bg-green-400 hover:bg-green-300 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Logging…' : 'Done ✓'}
            </button>
          </div>
        </div>

        {/* ── Right / bottom: history ─────────────────────────────── */}
        <div className="flex-1 flex flex-col min-h-0 border-t border-slate-700/60 lg:border-t-0 bg-slate-900/60">

          {/* Stats */}
          <div className="shrink-0 grid grid-cols-3 divide-x divide-slate-700/60 border-b border-slate-700/60">
            <StatCell label="Total" value={String(completions.length)} />
            <StatCell label="Avg interval" value={stats.avgInterval} />
            <StatCell label="Target" value={chore.target_cadence_days ? `${chore.target_cadence_days}d` : '—'} />
          </div>

          {/* Scrollable history area */}
          <div className="flex-1 overflow-y-auto">

            {/* Heatmap */}
            <div className="px-5 pt-4 pb-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">Past year</p>
              <div ref={heatmapRef} className="overflow-x-auto scrollbar-none">
                <Heatmap weeks={heatmap} />
              </div>
            </div>

            {/* Completion list */}
            <div className="px-5 pb-6">
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-2">
                History {completions.length > 0 && `· ${completions.length}`}
              </p>
              {completions.length === 0 ? (
                <p className="text-sm text-slate-600 py-4 text-center">No completions yet.</p>
              ) : (
                <div>
                  {completions.map((evt, i) => {
                    const prev = completions[i + 1]
                    const gapDays = prev
                      ? dayjs(evt.completed_at).diff(dayjs(prev.completed_at), 'day')
                      : null
                    return (
                      <div key={evt.id}>
                        <CompletionRow evt={evt} onDelete={() => handleDelete(evt.id)} />
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
    <div className="py-3 px-4 text-center">
      <p className="text-lg font-bold text-slate-100 tabular-nums">{value}</p>
      <p className="text-xs text-slate-500 mt-0.5">{label}</p>
    </div>
  )
}

function CompletionRow({ evt, onDelete }: { evt: CompletionEvent; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const dt = dayjs(evt.completed_at)
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-slate-700/30 group">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-medium text-slate-200">{dt.format('MMM D, YYYY')}</span>
          <span className="text-xs text-slate-500">{dt.format('h:mm A')}</span>
          {evt.source === 'dayglance' && (
            <span className="text-xs text-blue-400 bg-blue-400/10 px-1.5 py-0.5 rounded">via dayGLANCE</span>
          )}
        </div>
        {evt.note && <p className="text-xs text-slate-400 italic mt-0.5">{evt.note}</p>}
      </div>
      {confirming ? (
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setConfirming(false)} className="text-xs text-slate-400 hover:text-slate-200">Cancel</button>
          <button onClick={onDelete} className="text-xs text-red-400 hover:text-red-300 font-medium">Delete</button>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className="text-slate-700 hover:text-red-400 transition-colors shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100"
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  )
}

function GapMarker({ days, target }: { days: number; target: number | null }) {
  const overdue = target !== null && days > target
  return (
    <div className="flex items-center gap-2 py-1 pl-2">
      <div className={`w-px h-4 rounded-full ${overdue ? 'bg-red-800' : 'bg-slate-700'}`} />
      <span className={`text-xs tabular-nums ${overdue ? 'text-red-500' : 'text-slate-600'}`}>
        {days === 1 ? '1 day later' : `${days} days later`}
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
          <div key={wi} className="w-[11px] text-[9px] text-slate-600 text-center leading-none">
            {months.get(wi) ?? ''}
          </div>
        ))}
      </div>
      <div className="flex gap-[3px]">
        <div className="flex flex-col gap-[3px] mr-1">
          {DAY_LABELS.map((l, i) => (
            <div key={i} className="h-[11px] w-3 text-[9px] text-slate-600 text-right leading-[11px]">{l}</div>
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

// ── Data helpers ──────────────────────────────────────────────────────────────

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
