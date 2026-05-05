import { useState } from 'react'
import { X, Smile } from 'lucide-react'
import type { Category } from '@/types'
import { createCategory, updateCategory } from '@/db/queries'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { IconPicker } from '@/components/IconPicker/IconPicker'
import { ICON_REGISTRY } from '@/icons/registry'

interface Props {
  category?: Category
  onClose: () => void
  onSaved: () => void
}

export function CategoryFormModal({ category, onClose, onSaved }: Props) {
  const isEdit = Boolean(category)
  const [name, setName] = useState(category?.name ?? '')
  const [icon, setIcon] = useState<string | undefined>(category?.icon)
  const [showIconPicker, setShowIconPicker] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEscapeKey(showIconPicker ? () => setShowIconPicker(false) : onClose)

  async function handleSave() {
    const trimmed = name.trim()
    if (!trimmed) { setError('Name is required'); return }
    setSaving(true)
    try {
      if (isEdit && category) {
        await updateCategory(category.id, { name: trimmed, icon })
      } else {
        await createCategory(trimmed, undefined, icon)
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
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
        onClick={e => { if (e.target === e.currentTarget) onClose() }}
      >
        <div className="w-full sm:max-w-sm bg-slate-800 rounded-t-2xl sm:rounded-2xl p-6 space-y-4 shadow-2xl border border-slate-700/50">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-100">
              {isEdit ? 'Rename category' : 'Add category'}
            </h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-200 transition-colors">
              <X size={18} />
            </button>
          </div>

          <div className="flex gap-2">
            <div className="flex-1">
              <input
                type="text"
                value={name}
                onChange={e => { setName(e.target.value); setError('') }}
                placeholder="e.g. Home, Pets, Vehicle…"
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
                className="w-full bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 border border-slate-600 focus:outline-none focus:ring-2 focus:ring-glance-green"
              />
            </div>
            <button
              type="button"
              onClick={() => setShowIconPicker(true)}
              className="h-[38px] w-[38px] flex items-center justify-center bg-slate-700 rounded-lg border border-slate-600 hover:border-glance-green/60 transition-colors text-slate-400 hover:text-glance-green"
              title="Pick icon"
            >
              {SelectedIcon ? <SelectedIcon size={18} className="text-glance-green" /> : <Smile size={16} />}
            </button>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-300 bg-slate-700 hover:bg-slate-600 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-900 bg-glance-green hover:bg-green-300 disabled:opacity-50 transition-colors"
            >
              {saving ? 'Saving…' : isEdit ? 'Rename' : 'Add'}
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
