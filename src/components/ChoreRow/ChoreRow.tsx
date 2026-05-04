import type { ChoreWithLastCompletion } from '@/types'
import { getFillRatio, getCadenceColor, formatElapsed } from '@/utils/cadence'

interface Props {
  chore: ChoreWithLastCompletion
  onTap: (chore: ChoreWithLastCompletion) => void
}

export function ChoreRow({ chore, onTap }: Props) {
  const hasCadence = chore.target_cadence_days !== null
  const ratio = hasCadence && chore.elapsed_days !== null
    ? getFillRatio(chore.elapsed_days, chore.target_cadence_days!)
    : null
  const barColor = ratio !== null ? getCadenceColor(ratio) : '#475569'
  const barWidth = ratio !== null ? `${Math.min(ratio * 100, 100)}%` : '0%'
  const elapsedText = formatElapsed(chore.elapsed_days, chore.last_completed_at)

  return (
    <button
      onClick={() => onTap(chore)}
      className="w-full text-left group focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
      aria-label={`Log completion for ${chore.name}`}
    >
      <div className="flex items-center justify-between px-4 py-2 gap-4">
        <span className="text-sm text-slate-200 truncate min-w-0 flex-1 group-hover:text-white transition-colors">
          {chore.name}
        </span>
        <span className="text-xs text-slate-400 tabular-nums shrink-0 w-20 text-right">
          {elapsedText}
        </span>
      </div>

      <div className="mx-4 mb-3 h-1.5 rounded-full bg-slate-700 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: barWidth, backgroundColor: barColor }}
        />
      </div>
    </button>
  )
}
