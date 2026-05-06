import { useState, useEffect, useCallback } from 'react'
import { Pencil, Check, Sun, Moon, Archive } from 'lucide-react'
import { Ribbon } from '@/components/Ribbon/Ribbon'
import { BackupModal } from '@/components/BackupModal/BackupModal'
import { getAllCompletionCounts } from '@/db/queries'
import dayjs from 'dayjs'

// ── Header heatmap ─────────────────────────────────────────────────────────────

type HeatDay = { date: string; count: number; isFuture: boolean }

function buildHeaderHeatmap(counts: Map<string, number>): HeatDay[][] {
  const today = dayjs()
  const start = today.subtract(51, 'week').startOf('week')
  const weeks: HeatDay[][] = []
  let cur = start
  for (let w = 0; w < 52; w++) {
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

const WAVE_WIDTH = 14
const WAVE_DURATION = 1500

function getWaveColor(wi: number, di: number, day: HeatDay, wavePos: number): string {
  if (day.isFuture) return 'transparent'
  const dist = wavePos - wi - di * 0.6
  if (dist < 0) return 'rgba(71,85,105,0.15)'
  if (dist >= WAVE_WIDTH) return heatCellColor(day)
  const t = dist / WAVE_WIDTH
  if (t < 0.15) return '#86efac'
  if (t < 0.40) return '#4ade80'
  if (t < 0.65) return '#22c55e'
  if (t < 0.85) return '#16a34a'
  return heatCellColor(day)
}

function HeaderHeatmap({ weeks }: { weeks: HeatDay[][] }) {
  const [wavePos, setWavePos] = useState(-WAVE_WIDTH)

  useEffect(() => {
    const start = performance.now()
    const totalRange = 52 + WAVE_WIDTH * 2
    let raf: number

    function step(now: number) {
      const pos = ((now - start) / WAVE_DURATION) * totalRange - WAVE_WIDTH
      setWavePos(pos)
      if (pos < 52 + WAVE_WIDTH) raf = requestAnimationFrame(step)
    }

    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="flex gap-[3px] items-end">
      {weeks.map((week, wi) => (
        <div key={wi} className="flex flex-col gap-[3px]">
          {week.map((day, di) => (
            <div
              key={di}
              title={day.isFuture ? '' : `${day.date}${day.count > 0 ? ` · ${day.count}` : ''}`}
              className="w-[9px] h-[9px] rounded-[2px]"
              style={{ backgroundColor: getWaveColor(wi, di, day, wavePos) }}
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
  const [showBackup, setShowBackup] = useState(false)
  const [ribbonKey, setRibbonKey] = useState(0)
  const [heatmapWeeks, setHeatmapWeeks] = useState<HeatDay[][]>([])
  const [waveKey, setWaveKey] = useState(0)
  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains('dark')
  )

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
    localStorage.setItem('theme', isDark ? 'dark' : 'light')
  }, [isDark])

  const loadHeatmap = useCallback(async () => {
    const counts = await getAllCompletionCounts()
    setHeatmapWeeks(buildHeaderHeatmap(counts))
    setWaveKey(k => k + 1)
  }, [])

  useEffect(() => { loadHeatmap() }, [loadHeatmap])

  function toggleTheme() {
    setIsDark(d => !d)
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      <header className="shrink-0 px-5 pt-5 pb-4 border-b border-slate-200 dark:border-slate-800/80 flex items-end justify-between gap-4">
        {/* Logo + heatmap */}
        <div className="flex items-end gap-5 min-w-0">
          <div className="shrink-0">
            <h1 className="text-3xl md:text-4xl font-black tracking-tight leading-none text-slate-900 dark:text-slate-100">
              last<span className="italic text-green-400">GLANCE</span>
            </h1>
            <p className="text-xs text-slate-400 dark:text-slate-600 mt-1 tracking-wide">when did you last...?</p>
          </div>

          {heatmapWeeks.length > 0 && (
            <>
              {/* 26 weeks on landscape mobile / small screens */}
              <div className="hidden md:block lg:hidden pb-0.5 opacity-80">
                <HeaderHeatmap key={waveKey} weeks={heatmapWeeks.slice(-26)} />
              </div>
              {/* 52 weeks on large screens */}
              <div className="hidden lg:block pb-0.5 opacity-80">
                <HeaderHeatmap key={waveKey} weeks={heatmapWeeks} />
              </div>
            </>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors"
            aria-label="Toggle theme"
          >
            {isDark ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button
            onClick={() => setShowBackup(true)}
            className="p-2 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 border border-slate-200 dark:border-slate-700 transition-colors"
            aria-label="Backup & Restore"
          >
            <Archive size={15} />
          </button>
          <button
            onClick={() => setEditMode(e => !e)}
            className={`
              flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors border
              ${editMode
                ? 'text-green-400 border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60'
                : 'text-slate-500 dark:text-slate-500 border-slate-200 dark:border-slate-700 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'}
            `}
            aria-label={editMode ? 'Done editing' : 'Edit categories and chores'}
          >
            {editMode ? <><Check size={14} /> Done</> : <><Pencil size={14} /> Edit</>}
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col overflow-hidden">
        <Ribbon key={ribbonKey} editMode={editMode} onLogged={loadHeatmap} />
      </main>

      {showBackup && (
        <BackupModal
          onClose={() => setShowBackup(false)}
          onImported={() => { loadHeatmap(); setRibbonKey(k => k + 1) }}
        />
      )}
    </div>
  )
}
