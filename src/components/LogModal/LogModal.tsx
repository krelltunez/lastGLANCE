import { useState } from 'react'
import { X } from 'lucide-react'
import type { ChoreWithLastCompletion } from '@/types'
import { logCompletion } from '@/db/queries'
import dayjs from 'dayjs'
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

  const elapsedText = formatElapsed(chore.elapsed_days, chore.last_completed_at)

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-md bg-slate-800 rounded-t-2xl sm:rounded-2xl p-6 space-y-4 shadow-2xl border border-slate-700/50">
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

        <div className="flex gap-3 pt-1">
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
    </div>
  )
}
