import { useState, useEffect, useCallback } from 'react'
import { Pencil, Check } from 'lucide-react'
import { Ribbon } from '@/components/Ribbon/Ribbon'
import { getAllCompletionCounts } from '@/db/queries'
import dayjs from 'dayjs'

// ── Header heatmap ─────────────────────────────────────────────────────────────

type HeatDay = { date: string; count: number; isFuture: boolean }

function buildHeaderHeatmap(counts: Map<string, number>): HeatDay[][] {
  const today = dayjs()
  const start = today.subtract(25, 'week').startOf('week')
  const weeks: HeatDay[][] = []
  let cur = start
  for (let w = 0; w < 26; w++) {
    const week: HeatDay[] = []
    for (let d = 0; d < 7; d++) {
      const date = cur.format('YYYY-MM-DD')
      week.push({ date, count: counts.get(date) ?? 0, isFuture: cur.isAfter(today) })
      cur = cur.add(1, 'day')
    }
    weeks.push(week)
  }
  return weeks
}

function heatCellColor(day: HeatDay): string {
  if (day.isFuture) return 'transparent'
  if (day.count === 0) return 'rgba(71,85,105,0.4)'
  if (day.count === 1) return '#166534'
  if (day.count === 2) return '#16a34a'
  if (day.count <= 4) return '#22c55e'
  return '#4ade80'
}

function HeaderHeatmap({ weeks }: { weeks: HeatDay[][] }) {
  return (
    <div className="flex gap-[3px] items-end">
      {weeks.map((week, wi) => (
        <div key={wi} className="flex flex-col gap-[3px]">
          {week.map((day, di) => (
            <div
              key={di}
              title={day.isFuture ? '' : `${day.date}${day.count > 0 ? ` · ${day.count}` : ''}`}
              className="w-[9px] h-[9px] rounded-[2px]"
              style={{ backgroundColor: heatCellColor(day) }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const [editMode, setEditMode] = useState(false)
  const [heatmapWeeks, setHeatmapWeeks] = useState<HeatDay[][]>([])

  const loadHeatmap = useCallback(async () => {
    const counts = await getAllCompletionCounts()
    setHeatmapWeeks(buildHeaderHeatmap(counts))
  }, [])

  useEffect(() => { loadHeatmap() }, [loadHeatmap])

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col">
      <header className="shrink-0 px-5 pt-5 pb-4 border-b border-slate-800/80 flex items-end justify-between gap-4">
        {/* Logo + heatmap */}
        <div className="flex items-end gap-5 min-w-0">
          <div className="shrink-0">
            <h1 className="text-4xl font-black tracking-tight leading-none text-slate-100">
              last<span className="italic text-green-400">GLANCE</span>
            </h1>
            <p className="text-xs text-slate-600 mt-1 tracking-wide">when did you last...?</p>
          </div>

          {/* Compact heatmap — hidden on small screens */}
          {heatmapWeeks.length > 0 && (
            <div className="hidden md:block pb-0.5 opacity-80">
              <HeaderHeatmap weeks={heatmapWeeks} />
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => setEditMode(e => !e)}
            className={`
              flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors border
              ${editMode
                ? 'text-green-400 border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60'
                : 'text-slate-300 border-slate-700 hover:text-white hover:bg-slate-800 hover:border-slate-600'}
            `}
            aria-label={editMode ? 'Done editing' : 'Edit categories and chores'}
          >
            {editMode ? <><Check size={14} /> Done</> : <><Pencil size={14} /> Edit</>}
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col overflow-hidden">
        <Ribbon editMode={editMode} onLogged={loadHeatmap} />
      </main>
    </div>
  )
}
