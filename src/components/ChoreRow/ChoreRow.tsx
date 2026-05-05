import { useState } from 'react'
import { Check, Pencil, Trash2 } from 'lucide-react'
import type { ChoreWithLastCompletion } from '@/types'
import { getFillRatio, getCadenceColor, formatElapsed } from '@/utils/cadence'
import { logCompletion } from '@/db/queries'
import { ICON_REGISTRY } from '@/icons/registry'

interface Props {
  chore: ChoreWithLastCompletion
  editMode: boolean
  onTap: (chore: ChoreWithLastCompletion) => void
  onEdit: () => void
  onDelete: () => void
  onRefresh: () => void
}

type LogState = 'idle' | 'saving' | 'done'

export function ChoreRow({ chore, editMode, onTap, onEdit, onDelete, onRefresh }: Props) {
  const [logState, setLogState] = useState<LogState>('idle')

  const hasCadence = chore.target_cadence_days !== null
  const ratio = hasCadence && chore.elapsed_days !== null
    ? getFillRatio(chore.elapsed_days, chore.target_cadence_days!)
    : null
  const fillColor = ratio !== null ? getCadenceColor(ratio) : '#64748b'
  const fillWidth = ratio !== null ? `${Math.min(ratio * 100, 100)}%` : '0%'
  const elapsedText = formatElapsed(chore.elapsed_days, chore.last_completed_at)

  const ChoreIcon = chore.icon ? ICON_REGISTRY[chore.icon] : null

  async function handleQuickLog(e: React.MouseEvent) {
    e.stopPropagation()
    if (logState !== 'idle') return
    setLogState('saving')
    try {
      await logCompletion(chore.id)
      setLogState('done')
      onRefresh()
      setTimeout(() => setLogState('idle'), 1500)
    } catch {
      setLogState('idle')
    }
  }

  if (editMode) {
    return (
      <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-slate-800/60 border border-slate-700/40">
        {ChoreIcon && (
          <ChoreIcon size={14} className="text-slate-500 shrink-0" />
        )}
        <span className="text-sm text-slate-300 truncate flex-1 min-w-0">{chore.name}</span>
        {chore.target_cadence_days != null && (
          <span className="text-xs text-slate-600 shrink-0">every {chore.target_cadence_days}d</span>
        )}
        <button
          onClick={onEdit}
          className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-700 transition-colors shrink-0"
          aria-label={`Edit ${chore.name}`}
        >
          <Pencil size={13} />
        </button>
        <button
          onClick={onDelete}
          className="p-1.5 rounded-lg text-slate-500 hover:text-red-400 hover:bg-slate-700 transition-colors shrink-0"
          aria-label={`Delete ${chore.name}`}
        >
          <Trash2 size={13} />
        </button>
      </div>
    )
  }

  return (
    <div
      onClick={() => onTap(chore)}
      className="relative overflow-hidden rounded-xl bg-slate-800 border border-slate-700/40 cursor-pointer group transition-colors hover:border-slate-600/60"
      role="button"
      aria-label={`${chore.name} — ${elapsedText}`}
    >
      {/* Chunky background fill bar */}
      <div
        className="absolute inset-y-0 left-0 transition-all duration-700 ease-out"
        style={{
          width: fillWidth,
          backgroundColor: fillColor,
          opacity: 0.13,
        }}
      />

      {/* Content layer */}
      <div className="relative flex items-center gap-3 px-4 py-3.5">
        {/* Icon */}
        {ChoreIcon && (
          <ChoreIcon
            size={18}
            className="shrink-0 transition-colors"
            style={{ color: fillColor, opacity: 0.85 }}
          />
        )}

        {/* Name + elapsed */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-slate-100 group-hover:text-white transition-colors truncate leading-snug">
            {chore.name}
          </p>
          <p className="text-xs text-slate-500 tabular-nums mt-0.5">{elapsedText}</p>
        </div>

        {/* Quick-log button */}
        <button
          onClick={handleQuickLog}
          disabled={logState === 'saving'}
          aria-label={`Quick-log ${chore.name}`}
          className={`
            shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium
            transition-all duration-200 border
            ${logState === 'done'
              ? 'bg-green-500/20 border-green-500/40 text-green-400'
              : 'bg-slate-700/60 border-slate-600/40 text-slate-400 hover:text-slate-100 hover:bg-slate-700 hover:border-slate-500/60 group-hover:border-slate-600/60'}
          `}
        >
          <Check size={12} strokeWidth={2.5} />
          <span>{logState === 'done' ? 'Logged!' : logState === 'saving' ? '…' : 'Done'}</span>
        </button>
      </div>
    </div>
  )
}
