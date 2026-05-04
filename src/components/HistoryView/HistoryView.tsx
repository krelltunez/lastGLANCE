import { useState, useEffect, useRef } from 'react'
import { X, ArrowLeft, Trash2 } from 'lucide-react'
import dayjs from 'dayjs'
import type { ChoreWithLastCompletion, CompletionEvent } from '@/types'
import { getCompletionHistory, deleteCompletion } from '@/db/queries'

interface Props {
  chore: ChoreWithLastCompletion
  onBack: () => void
  onClose: () => void
  onChanged: () => void
}

export function HistoryView({ chore, onBack, onClose, onChanged }: Props) {
  const [completions, setCompletions] = useState<CompletionEvent[]>([])
  const [loading, setLoading] = useState(true)
  const heatmapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    getCompletionHistory(chore.id, 1000).then(c => {
      setCompletions(c)
      setLoading(false)
    })
  }, [chore.id])

  // Scroll heatmap to the right (most recent) on load
  useEffect(() => {
    if (!loading && heatmapRef.current) {
      heatmapRef.current.scrollLeft = heatmapRef.current.scrollWidth
    }
  }, [loading])

  async function handleDelete(id: number) {
    await deleteCompletion(id)
    const updated = await getCompletionHistory(chore.id, 1000)
    setCompletions(updated)
    onChanged()
  }

  const stats = computeStats(completions, chore.target_cadence_days)
  const heatmap = buildHeatmap(completions)

  return (
    <div className="fixed inset-0 z-60 flex flex-col bg-slate-900 animate-slide-up">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-3 border-b border-slate-700/60">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-200 transition-colors"
        >
          <ArrowLeft size={16} />
          Back
        </button>
        <h2 className="text-sm font-semibold text-slate-100 truncate px-4">{chore.name}</h2>
        <button onClick={onClose} className="text-slate-400 hover:text-slate-200 transition-colors">
          <X size={18} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Stats row */}
        <div className="grid grid-cols-3 gap-px bg-slate-700/40 border-b border-slate-700/60">
          <StatCard label="Total" value={String(stats.total)} />
          <StatCard label="Avg interval" value={stats.avgInterval} />
          <StatCard label="Cadence" value={chore.target_cadence_days ? `${chore.target_cadence_days}d` : '—'} />
        </div>

        {/* Calendar heatmap */}
        <div className="px-4 pt-5 pb-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
            Past year
          </p>
          {loading ? (
            <div className="h-24 flex items-center justify-center text-slate-600 text-sm">Loading…</div>
          ) : (
            <div
              ref={heatmapRef}
              className="overflow-x-auto scrollbar-none pb-1"
            >
              <Heatmap weeks={heatmap} />
            </div>
          )}
        </div>

        {/* Completion list */}
        <div className="px-4 pb-8">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-3">
            Completions {completions.length > 0 && `(${completions.length})`}
          </p>

          {completions.length === 0 && !loading && (
            <p className="text-sm text-slate-500 text-center py-8">No completions logged yet.</p>
          )}

          <div className="space-y-0">
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
        </div>
      </div>
    </div>
  )
}

// ── Sub-components ──────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-slate-900 px-4 py-4 text-center">
      <p className="text-xl font-bold text-slate-100 tabular-nums">{value}</p>
      <p className="text-xs text-slate-500 mt-0.5">{label}</p>
    </div>
  )
}

function CompletionRow({ evt, onDelete }: { evt: CompletionEvent; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false)
  const dt = dayjs(evt.completed_at)

  return (
    <div className="flex items-start gap-3 py-3 border-b border-slate-700/30 group">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-medium text-slate-200">{dt.format('MMM D, YYYY')}</span>
          <span className="text-xs text-slate-500">{dt.format('h:mm A')}</span>
          {evt.source === 'dayglance' && (
            <span className="text-xs text-blue-400 bg-blue-400/10 px-1.5 py-0.5 rounded">via dayGLANCE</span>
          )}
        </div>
        {evt.note && (
          <p className="text-xs text-slate-400 italic mt-0.5 truncate">{evt.note}</p>
        )}
      </div>

      {confirming ? (
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setConfirming(false)}
            className="text-xs text-slate-400 hover:text-slate-200"
          >
            Cancel
          </button>
          <button
            onClick={onDelete}
            className="text-xs text-red-400 hover:text-red-300 font-medium"
          >
            Delete
          </button>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          className="text-slate-600 hover:text-red-400 transition-colors shrink-0 opacity-0 group-hover:opacity-100 focus:opacity-100"
          aria-label="Delete completion"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  )
}

function GapMarker({ days, target }: { days: number; target: number | null }) {
  const isOverdue = target !== null && days > target
  return (
    <div className="flex items-center gap-2 py-1.5 pl-2">
      <div className={`w-px h-5 rounded-full ${isOverdue ? 'bg-red-800' : 'bg-slate-700'}`} />
      <span className={`text-xs tabular-nums ${isOverdue ? 'text-red-500' : 'text-slate-600'}`}>
        {days === 1 ? '1 day later' : `${days} days later`}
      </span>
    </div>
  )
}

// ── Heatmap ─────────────────────────────────────────────────────────────────

type HeatmapDay = { date: string; count: number; isFuture: boolean }

function Heatmap({ weeks }: { weeks: HeatmapDay[][] }) {
  const today = dayjs().format('YYYY-MM-DD')
  const months = getMonthLabels(weeks)
  const DAY_LABELS = ['', 'M', '', 'W', '', 'F', '']

  return (
    <div className="inline-flex flex-col gap-1 select-none">
      {/* Month labels */}
      <div className="flex gap-[3px] mb-0.5 ml-5">
        {weeks.map((_week, wi) => {
          const label = months.get(wi)
          return (
            <div key={wi} className="w-[11px] text-[9px] text-slate-600 text-center leading-none">
              {label ?? ''}
            </div>
          )
        })}
      </div>

      {/* Grid: day-of-week rows × week columns */}
      <div className="flex gap-[3px]">
        {/* Day-of-week labels */}
        <div className="flex flex-col gap-[3px] mr-1 justify-start">
          {DAY_LABELS.map((label, i) => (
            <div key={i} className="h-[11px] w-3 text-[9px] text-slate-600 text-right leading-[11px]">
              {label}
            </div>
          ))}
        </div>

        {/* Week columns */}
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {week.map((day, di) => (
              <div
                key={di}
                title={day.isFuture ? '' : `${day.date}${day.count > 0 ? ` · ${day.count} completion${day.count > 1 ? 's' : ''}` : ''}`}
                className="w-[11px] h-[11px] rounded-[2px] transition-colors"
                style={{ backgroundColor: cellColor(day, today) }}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function cellColor(day: HeatmapDay, today: string): string {
  if (day.isFuture) return 'transparent'
  if (day.date === today && day.count === 0) return '#1e3a2f' // subtle today highlight
  if (day.count === 0) return '#1e293b'
  if (day.count === 1) return '#16a34a' // green-600
  return '#4ade80' // green-400 for 2+
}

function getMonthLabels(weeks: HeatmapDay[][]): Map<number, string> {
  const labels = new Map<number, string>()
  let lastMonth = -1
  weeks.forEach((week, wi) => {
    const month = dayjs(week[0].date).month()
    if (month !== lastMonth) {
      labels.set(wi, dayjs(week[0].date).format('MMM'))
      lastMonth = month
    }
  })
  return labels
}

// ── Data helpers ─────────────────────────────────────────────────────────────

function buildHeatmap(completions: CompletionEvent[]): HeatmapDay[][] {
  const byDate = new Map<string, number>()
  for (const c of completions) {
    const d = dayjs(c.completed_at).format('YYYY-MM-DD')
    byDate.set(d, (byDate.get(d) ?? 0) + 1)
  }

  const today = dayjs()
  // Start on the Sunday 51 weeks ago
  const start = today.subtract(51, 'week').startOf('week')
  const weeks: HeatmapDay[][] = []
  let cur = start

  for (let w = 0; w < 52; w++) {
    const week: HeatmapDay[] = []
    for (let d = 0; d < 7; d++) {
      const date = cur.format('YYYY-MM-DD')
      week.push({ date, count: byDate.get(date) ?? 0, isFuture: cur.isAfter(today) })
      cur = cur.add(1, 'day')
    }
    weeks.push(week)
  }
  return weeks
}

function computeStats(completions: CompletionEvent[], _targetDays: number | null) {
  const total = completions.length
  if (total < 2) return { total, avgInterval: '—' }

  const gaps: number[] = []
  for (let i = 0; i < completions.length - 1; i++) {
    gaps.push(
      dayjs(completions[i].completed_at).diff(dayjs(completions[i + 1].completed_at), 'day')
    )
  }
  const avg = Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)
  return { total, avgInterval: avg === 1 ? '1 day' : `${avg} days` }
}
