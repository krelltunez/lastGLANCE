import { useState, useMemo } from 'react'
import { ChevronLeft, ChevronRight, Clock, CalendarDays } from 'lucide-react'
import dayjs from 'dayjs'

interface Props {
  date: string
  time: string
  onDateChange: (d: string) => void
  onTimeChange: (t: string) => void
  maxDate?: string
}

const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

type DayCell = {
  date: string
  day: number
  currentMonth: boolean
  isToday: boolean
  isDisabled: boolean
}

export function DateTimePicker({ date, time, onDateChange, onTimeChange, maxDate }: Props) {
  const today = dayjs().format('YYYY-MM-DD')
  const limit = maxDate ?? today
  const [open, setOpen] = useState(false)
  const [viewDate, setViewDate] = useState(() => date ? dayjs(date) : dayjs())

  const cells = useMemo<DayCell[]>(() => {
    const startOfGrid = viewDate.startOf('month').startOf('week')
    const result: DayCell[] = []
    for (let i = 0; i < 42; i++) {
      const d = startOfGrid.add(i, 'day')
      const ds = d.format('YYYY-MM-DD')
      result.push({
        date: ds,
        day: d.date(),
        currentMonth: d.month() === viewDate.month(),
        isToday: ds === today,
        isDisabled: ds > limit,
      })
    }
    const needsSixthRow = result.slice(35).some(c => c.currentMonth)
    return needsSixthRow ? result : result.slice(0, 35)
  }, [viewDate, today, limit])

  function select(cell: DayCell) {
    if (cell.isDisabled) return
    onDateChange(cell.date)
    setViewDate(dayjs(cell.date))
  }

  function clear() {
    onDateChange('')
    onTimeChange('')
    setOpen(false)
  }

  const displayLabel = date
    ? `${dayjs(date).format('MMM D, YYYY')}${time ? ` · ${time}` : ''}`
    : null

  return (
    <div className="space-y-1.5">
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`
          w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm border transition-colors text-left
          ${open
            ? 'bg-slate-100 dark:bg-slate-700 border-green-400/40 text-slate-800 dark:text-slate-100'
            : date
              ? 'bg-slate-100 dark:bg-slate-700 border-slate-200 dark:border-slate-600 text-slate-800 dark:text-slate-100 hover:border-slate-300 dark:hover:border-slate-500'
              : 'bg-slate-100 dark:bg-slate-700 border-slate-200 dark:border-slate-600 text-slate-400 dark:text-slate-500 hover:border-slate-300 dark:hover:border-slate-500'}
        `}
      >
        <CalendarDays size={14} className={date ? 'text-green-400' : 'text-slate-400 dark:text-slate-500'} />
        <span className="flex-1">{displayLabel ?? 'Set date…'}</span>
        {date && (
          <span
            role="button"
            onClick={e => { e.stopPropagation(); clear() }}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors text-xs px-1"
          >
            ✕
          </span>
        )}
      </button>

      {/* Calendar */}
      {open && (
        <div className="bg-slate-50 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-700/60 overflow-hidden">
          {/* Month nav */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800">
            <button
              onClick={() => setViewDate(v => v.subtract(1, 'month'))}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <ChevronLeft size={15} />
            </button>
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              {viewDate.format('MMMM YYYY')}
            </span>
            <button
              onClick={() => setViewDate(v => v.add(1, 'month'))}
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            >
              <ChevronRight size={15} />
            </button>
          </div>

          {/* Day header */}
          <div className="grid grid-cols-7 px-3 pt-3 pb-1">
            {DAY_LABELS.map(l => (
              <div key={l} className="text-center text-xs font-medium text-slate-400 dark:text-slate-600">{l}</div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 px-3 pb-3 gap-y-0.5">
            {cells.map((cell, i) => {
              const isSelected = cell.date === date
              return (
                <button
                  key={i}
                  onClick={() => select(cell)}
                  disabled={cell.isDisabled}
                  className={`
                    relative flex items-center justify-center h-8 rounded-lg text-sm transition-colors
                    ${cell.isDisabled
                      ? 'text-slate-300 dark:text-slate-800 cursor-not-allowed'
                      : isSelected
                        ? 'bg-green-400/20 text-green-500 dark:text-green-400 font-semibold ring-1 ring-inset ring-green-400/50'
                        : cell.currentMonth
                          ? 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
                          : 'text-slate-400 dark:text-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800'}
                  `}
                >
                  {cell.day}
                  {cell.isToday && !isSelected && (
                    <span className="absolute bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-green-400/60" />
                  )}
                </button>
              )
            })}
          </div>

          {/* Time row */}
          <div className="flex items-center gap-3 px-4 py-3 border-t border-slate-100 dark:border-slate-800">
            <Clock size={13} className="text-slate-400 dark:text-slate-500 shrink-0" />
            <span className="text-xs text-slate-400 dark:text-slate-500">Time</span>
            <input
              type="time"
              value={time}
              onChange={e => onTimeChange(e.target.value)}
              disabled={!date}
              style={{ colorScheme: 'dark' }}
              className="flex-1 bg-transparent text-sm text-slate-700 dark:text-slate-200 text-right focus:outline-none disabled:text-slate-300 dark:disabled:text-slate-700 disabled:cursor-not-allowed [&::-webkit-calendar-picker-indicator]:hidden"
            />
            {time && (
              <button
                onClick={() => onTimeChange('')}
                className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors shrink-0"
              >
                clear
              </button>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-100 dark:border-slate-800">
            <button
              onClick={clear}
              className="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
            >
              Clear
            </button>
            <button
              onClick={() => { onDateChange(today); setViewDate(dayjs()); onTimeChange('') }}
              className="text-xs text-green-500 dark:text-green-400 hover:text-green-400 dark:hover:text-green-300 transition-colors font-medium"
            >
              Today
            </button>
          </div>
        </div>
      )}

      {date && !time && open && (
        <p className="text-xs text-slate-400 dark:text-slate-600">No time set — will use noon</p>
      )}
    </div>
  )
}
