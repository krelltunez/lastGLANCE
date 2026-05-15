import { useState } from 'react'
import { X, Smile, Bell } from 'lucide-react'
import type { Chore, Category } from '@/types'
import { createChore, updateChore } from '@/db/queries'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { IconPicker } from '@/components/IconPicker/IconPicker'
import { ICON_REGISTRY } from '@/icons/registry'
import { requestNotificationPermission } from '@/hooks/useNotifications'

interface Props {
  category: Category
  categories?: Category[]
  chore?: Chore
  onClose: () => void
  onSaved: () => void
}

export function ChoreFormModal({ category, categories, chore, onClose, onSaved }: Props) {
  const isEdit = Boolean(chore)
  const [name, setName] = useState(chore?.name ?? '')
  const [cadence, setCadence] = useState(
    chore?.target_cadence_days != null ? String(chore.target_cadence_days) : ''
  )
  const [icon, setIcon] = useState<string | undefined>(chore?.icon)
  const [notify, setNotify] = useState(chore?.notify_when_overdue ?? false)
  const [selectedCategoryId, setSelectedCategoryId] = useState<number>(chore?.category_id ?? category.id)
  const [notifyBlocked, setNotifyBlocked] = useState(false)
  const [showIconPicker, setShowIconPicker] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEscapeKey(showIconPicker ? () => setShowIconPicker(false) : onClose)

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
        await updateChore(chore.id, { name: trimmed, target_cadence_days: cadenceDays, notify_when_overdue: notify, icon, category_id: selectedCategoryId })
      } else {
        await createChore({
          name: trimmed,
          category_id: category.id,
          target_cadence_days: cadenceDays,
          notify_when_overdue: notify,
          auto_schedule_to_dayglance: false,
          preferred_schedule_behavior: null,
          icon,
        })
      }
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  const SelectedIcon = icon ? ICON_REGISTRY[icon] : null

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm"
        onClick={e => { if (e.target === e.currentTarget) onClose() }}
      >
        <div className="w-full sm:max-w-md bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl p-6 space-y-4 shadow-2xl border border-slate-200 dark:border-slate-700/50">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
              {isEdit ? 'Edit chore' : `Add chore — ${category.name}`}
            </h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
              <X size={18} />
            </button>
          </div>

          <div className="space-y-3">
            <div className="flex gap-2">
              <div className="flex-1">
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={e => { setName(e.target.value); setError('') }}
                  placeholder="e.g. Mop kitchen"
                  autoFocus
                  onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
                  className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Icon</label>
                <button
                  type="button"
                  onClick={() => setShowIconPicker(true)}
                  className="h-[38px] w-[38px] flex items-center justify-center bg-slate-100 dark:bg-slate-700 rounded-lg border border-slate-200 dark:border-slate-600 hover:border-green-400/60 transition-colors text-slate-400 hover:text-green-400"
                  title="Pick icon"
                >
                  {SelectedIcon ? <SelectedIcon size={18} className="text-green-400" /> : <Smile size={16} />}
                </button>
              </div>
            </div>

            {isEdit && categories && categories.length > 1 && (
              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">Category</label>
                <select
                  value={selectedCategoryId}
                  onChange={e => setSelectedCategoryId(Number(e.target.value))}
                  className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                >
                  {categories.map(cat => (
                    <option key={cat.id} value={cat.id}>{cat.name}</option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                Cadence <span className="text-slate-400 dark:text-slate-500">(days, optional)</span>
              </label>
              <input
                type="number"
                min="1"
                value={cadence}
                onChange={e => { setCadence(e.target.value); setError('') }}
                placeholder="e.g. 14"
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                Leave blank for no target — just tracking.
              </p>
            </div>

            {cadence.trim() && (
              <div className="flex items-center justify-between py-1">
                <div className="flex items-center gap-2">
                  <Bell size={13} className={notify ? 'text-green-400' : 'text-slate-400 dark:text-slate-500'} />
                  <span className="text-sm text-slate-600 dark:text-slate-300">Notify when overdue</span>
                </div>
                <button
                  type="button"
                  onClick={async () => {
                    if (!notify) {
                      const perm = await requestNotificationPermission()
                      if (perm === 'denied') { setNotifyBlocked(true); return }
                      setNotifyBlocked(false)
                    }
                    setNotify(v => !v)
                  }}
                  className={`relative w-10 h-6 rounded-full transition-colors ${notify ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'}`}
                  aria-checked={notify}
                  role="switch"
                >
                  <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${notify ? 'translate-x-4' : ''}`} />
                </button>
              </div>
            )}
            {notifyBlocked && (
              <p className="text-xs text-amber-500 dark:text-amber-400">Notifications blocked — enable them in your browser settings.</p>
            )}

            {error && <p className="text-xs text-red-500">{error}</p>}
          </div>

          <div className="flex gap-3 pt-1">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-green-400 border border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : isEdit ? 'Save' : 'Add'}
            </button>
          </div>
        </div>
      </div>

      {showIconPicker && (
        <IconPicker
          selected={icon}
          onSelect={name => setIcon(name)}
          onClose={() => setShowIconPicker(false)}
        />
      )}
    </>
  )
}
