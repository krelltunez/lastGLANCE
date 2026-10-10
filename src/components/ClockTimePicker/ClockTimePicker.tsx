import { useState, useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { formatDayPeriod, uses24HourClock } from '@/utils/datetime'
import { useEscapeKey } from '@/hooks/useEscapeKey'

interface Props {
  /** "HH:mm", 24-hour. */
  value: string
  onChange: (t: string) => void
  onClose: () => void
}

// Clock-face time picker, ported from dayGLANCE's ClockTimePicker so the
// GLANCE apps share one picker: tap an hour, it flips to minutes, OK commits.
// 12-hour locales get a single ring plus an AM/PM toggle; 24-hour locales get
// an inner ring for 00 and 13–23.
export function ClockTimePicker({ value, onChange, onClose }: Props) {
  const { t } = useTranslation()
  const [h0, m0] = value.split(':').map(Number)
  const [hour, setHour] = useState(h0)
  const [minute, setMinute] = useState(m0)
  const [mode, setMode] = useState<'hour' | 'minute'>('hour')
  const use24 = uses24HourClock()
  const isAM = hour < 12

  // Escape and Android's Back close only this picker, not the modal under it:
  // it opened last, so it is the top of the dismiss stack.
  useEscapeKey(onClose)

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { e.preventDefault(); setMode('minute'); setMinute(m => (m + 1) % 60) }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { e.preventDefault(); setMode('minute'); setMinute(m => (m + 59) % 60) }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [])

  const wide = typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches
  const clockSize = wide ? 280 : 240
  const cx = clockSize / 2
  const outerR = wide ? 114 : 97
  const innerR = Math.round(outerR * 0.62)
  const outerBtn = wide ? 44 : 36
  const innerBtn = wide ? 36 : 28

  function confirm() {
    onChange(`${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`)
    onClose()
  }

  function toggleAMPM() {
    setHour(h => (h < 12 ? h + 12 : h - 12))
  }

  // Angle in degrees, 0 at 12 o'clock, clockwise.
  const pos = (deg: number, r: number) => ({
    x: cx + r * Math.cos((deg - 90) * Math.PI / 180),
    y: cx + r * Math.sin((deg - 90) * Math.PI / 180),
  })

  const hour12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
  const displayHour = use24 ? String(hour).padStart(2, '0') : String(hour12)

  const selectedCls = 'bg-green-500 text-white shadow-md'
  const idleCls = 'text-slate-700 dark:text-slate-200 hover:bg-black/5 dark:hover:bg-white/10'
  const idleInnerCls = 'text-slate-500 dark:text-slate-400 hover:bg-black/5 dark:hover:bg-white/10'
  const numSize = wide ? 'text-sm' : 'text-xs'

  function dialButton(key: string, label: string, deg: number, r: number, size: number, selected: boolean, onClick: () => void, inner = false, passive = false) {
    const { x, y } = pos(deg, r)
    return (
      <button
        type="button"
        key={key}
        onClick={onClick}
        tabIndex={passive ? -1 : undefined}
        className={`absolute rounded-full${passive ? ' pointer-events-none' : ''} flex items-center justify-center transition-all ${inner ? (wide ? 'text-xs' : 'text-[10px]') : `font-medium ${numSize}`} ${selected ? selectedCls : inner ? idleInnerCls : idleCls}`}
        style={{ width: size, height: size, left: x - size / 2, top: y - size / 2 }}
      >
        {label}
      </button>
    )
  }

  // Minutes: tap or drag anywhere on the face to land on any minute, like the
  // Android clock dial; the 5-minute labels are just markings.
  function minuteFromPointer(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    const dx = e.clientX - (r.left + r.width / 2)
    const dy = e.clientY - (r.top + r.height / 2)
    const deg = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360
    setMinute(Math.round(deg / 6) % 60)
  }

  function onFacePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    minuteFromPointer(e)
  }

  function onFacePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) minuteFromPointer(e)
  }

  function renderClock() {
    let handDeg: number
    let handR = outerR
    const buttons: ReactNode[] = []

    if (mode === 'minute') {
      handDeg = minute * 6
      for (let i = 0; i < 12; i++) {
        const min = i * 5
        buttons.push(dialButton(`m${min}`, String(min).padStart(2, '0'), min * 6, outerR, outerBtn, min === minute, () => setMinute(min), false, true))
      }
    } else if (use24) {
      if (hour >= 1 && hour <= 12) handDeg = (hour % 12) * 30
      else { handDeg = (hour % 12) * 30; handR = innerR }
      for (let i = 0; i < 12; i++) {
        const label = i === 0 ? 12 : i
        buttons.push(dialButton(`o${label}`, String(label), i * 30, outerR, outerBtn, hour === label, () => { setHour(label); setMode('minute') }))
      }
      for (let i = 0; i < 12; i++) {
        const label = i === 0 ? 0 : i + 12
        buttons.push(dialButton(`i${label}`, String(label).padStart(2, '0'), i * 30, innerR, innerBtn, hour === label, () => { setHour(label); setMode('minute') }, true))
      }
    } else {
      handDeg = (hour12 % 12) * 30
      ;[12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].forEach((label, i) => {
        buttons.push(dialButton(`h${label}`, String(label), i * 30, outerR, outerBtn, hour12 === label, () => {
          setHour(isAM ? (label === 12 ? 0 : label) : (label === 12 ? 12 : label + 12))
          setMode('minute')
        }))
      })
    }

    const { x: hx, y: hy } = pos(handDeg, handR)
    // A minute between the 5-minute labels has no highlighted label, so mark
    // the hand's tip instead.
    const offLabel = mode === 'minute' && minute % 5 !== 0
    return (
      <div
        onPointerDown={mode === 'minute' ? onFacePointerDown : undefined}
        onPointerMove={mode === 'minute' ? onFacePointerMove : undefined}
        className="relative rounded-full bg-[radial-gradient(circle_at_38%_33%,#ffffff_0%,#dde1e7_80%)] shadow-[inset_0_3px_12px_rgba(0,0,0,0.09),inset_0_-1px_4px_rgba(255,255,255,0.95)] dark:bg-[radial-gradient(circle_at_38%_33%,#334155_0%,#172033_80%)] dark:shadow-[inset_0_3px_12px_rgba(0,0,0,0.55),inset_0_-1px_4px_rgba(255,255,255,0.04)]"
        style={{ width: clockSize, height: clockSize, touchAction: mode === 'minute' ? 'none' : undefined }}
      >
        <svg width={clockSize} height={clockSize} className="absolute inset-0 pointer-events-none text-green-500">
          <line x1={cx} y1={cx} x2={hx} y2={hy} stroke="currentColor" strokeWidth="3" strokeLinecap="round" opacity="0.65" />
          <circle cx={hx} cy={hy} r={offLabel ? 7 : 5} fill="currentColor" opacity={offLabel ? 1 : 0.35} />
          <circle cx={cx} cy={cx} r="5" fill="currentColor" />
        </svg>
        {buttons}
      </div>
    )
  }

  const bigText = wide ? 'text-4xl w-16' : 'text-3xl w-12'

  // Portaled to body: the log modal's backdrop-blur makes it the containing
  // block for fixed children, which would trap this overlay inside the sheet.
  return createPortal(
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[90]" onClick={onClose}>
      <div className={`bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/50 rounded-3xl shadow-2xl ${wide ? 'p-7' : 'p-5'}`} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className={`${wide ? 'text-base' : 'text-sm'} font-semibold tracking-wide uppercase text-slate-500 dark:text-slate-400`}>{t('dateTimePicker.setTime')}</h3>
          <button type="button" onClick={onClose} className={`${wide ? 'p-2' : 'p-1'} rounded-full hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors`}>
            <X size={wide ? 20 : 17} className="text-slate-500 dark:text-slate-400" />
          </button>
        </div>

        <div className="flex justify-center mb-5">
          <div className="flex items-center gap-1 px-4 py-2 rounded-2xl bg-slate-100 dark:bg-slate-900/60">
            <button
              type="button"
              onClick={() => setMode('hour')}
              className={`${bigText} font-bold rounded-xl py-1 text-center transition-colors ${mode === 'hour' ? 'bg-green-500 text-white' : 'text-slate-800 dark:text-slate-100'}`}
            >
              {displayHour}
            </button>
            <span className={`${wide ? 'text-4xl' : 'text-3xl'} font-bold text-slate-500 dark:text-slate-400 select-none`}>:</span>
            <button
              type="button"
              onClick={() => setMode('minute')}
              className={`${bigText} font-bold rounded-xl py-1 text-center transition-colors ${mode === 'minute' ? 'bg-green-500 text-white' : 'text-slate-800 dark:text-slate-100'}`}
            >
              {String(minute).padStart(2, '0')}
            </button>
            {!use24 && (
              <button
                type="button"
                onClick={toggleAMPM}
                className={`${wide ? 'text-base px-3 py-2' : 'text-sm px-2.5 py-1.5'} font-semibold rounded-xl ml-1 transition-colors bg-white text-slate-600 hover:bg-slate-200 shadow-sm dark:shadow-none dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600`}
              >
                {formatDayPeriod(isAM)}
              </button>
            )}
          </div>
        </div>

        <div className="flex justify-center mb-5">{renderClock()}</div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className={`flex-1 ${wide ? 'py-3 text-base' : 'py-2.5 text-sm'} rounded-2xl font-medium bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600 transition-colors`}
          >
            {t('dateTimePicker.cancel')}
          </button>
          <button
            type="button"
            onClick={confirm}
            className={`flex-1 ${wide ? 'py-3 text-base' : 'py-2.5 text-sm'} rounded-2xl font-medium bg-green-500 text-white hover:bg-green-600 transition-colors`}
          >
            {t('dateTimePicker.ok')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
