import { Pencil, Trash2 } from 'lucide-react'
import type { ChoreWithLastCompletion } from '@/types'
import { getFillRatio, getCadenceColor, formatElapsed } from '@/utils/cadence'

interface Props {
  chore: ChoreWithLastCompletion
  editMode: boolean
  onTap: (chore: ChoreWithLastCompletion) => void
  onEdit: () => void
  onDelete: () => void
}

export function ChoreRow({ chore, editMode, onTap, onEdit, onDelete }: Props) {
  const hasCadence = chore.target_cadence_days !== null
  const ratio = hasCadence && chore.elapsed_days !== null
    ? getFillRatio(chore.elapsed_days, chore.target_cadence_days!)
    : null
  const barColor = ratio !== null ? getCadenceColor(ratio) : '#475569'
  const barWidth = ratio !== null ? `${Math.min(ratio * 100, 100)}%` : '0%'
  const elapsedText = formatElapsed(chore.elapsed_days, chore.last_completed_at)

  if (editMode) {
    return (
      <div className="flex items-center gap-2 px-4 py-2.5">
        <span className="text-sm text-slate-300 truncate flex-1">{chore.name}</span>
        {chore.target_cadence_days != null && (
          <span className="text-xs text-slate-500 shrink-0">every {chore.target_cadence_days}d</span>
        )}
        <button
          onClick={onEdit}
          className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors shrink-0"
          aria-label={`Edit ${chore.name}`}
        >
          <Pencil size={13} />
        </button>
        <button
          onClick={onDelete}
          className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-slate-700 transition-colors shrink-0"
          aria-label={`Delete ${chore.name}`}
        >
          <Trash2 size={13} />
        </button>
      </div>
    )
  }

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
