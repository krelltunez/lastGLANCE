import { useState } from 'react'
import { X } from 'lucide-react'
import type { Chore, Category } from '@/types'
import { createChore, updateChore } from '@/db/queries'

interface Props {
  category: Category
  chore?: Chore
  onClose: () => void
  onSaved: () => void
}

export function ChoreFormModal({ category, chore, onClose, onSaved }: Props) {
  const isEdit = Boolean(chore)
  const [name, setName] = useState(chore?.name ?? '')
  const [cadence, setCadence] = useState(
    chore?.target_cadence_days != null ? String(chore.target_cadence_days) : ''
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSave() {
    const trimmed = name.trim()
    if (!trimmed) { setError('Name is required'); return }
    const cadenceDays = cadence.trim() ? parseInt(cadence, 10) : null
    if (cadence.trim() && (isNaN(cadenceDays!) || cadenceDays! < 1)) {
      setError('Cadence must be a whole number of days'); return
    }
    setSaving(true)
    try {
      if (isEdit && chore) {
        await updateChore(chore.id, { name: trimmed, target_cadence_days: cadenceDays })
      } else {
        await createChore({
          name: trimmed,
          category_id: category.id,
          target_cadence_days: cadenceDays,
          auto_schedule_to_dayglance: false,
          preferred_schedule_behavior: null,
        })
      }
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-md bg-slate-800 rounded-t-2xl sm:rounded-2xl p-6 space-y-4 shadow-2xl border border-slate-700/50">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-slate-100">
            {isEdit ? 'Edit chore' : `Add chore — ${category.name}`}
          </h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 transition-colors">
            <X size={18} />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => { setName(e.target.value); setError('') }}
              placeholder="e.g. Mop kitchen"
              autoFocus
              className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 border border-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-400 mb-1">
              Cadence <span className="text-slate-500">(days, optional)</span>
            </label>
            <input
              type="number"
              min="1"
              value={cadence}
              onChange={e => { setCadence(e.target.value); setError('') }}
              placeholder="e.g. 14"
              className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 border border-slate-600 focus:outline-none focus:ring-2 focus:ring-slate-400"
            />
            <p className="text-xs text-slate-500 mt-1">
              Leave blank for no target — just tracking.
            </p>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>

        <div className="flex gap-3 pt-1">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-300 bg-slate-700 hover:bg-slate-600 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-900 bg-green-400 hover:bg-green-300 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving…' : isEdit ? 'Save' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  )
}
