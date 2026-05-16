import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Smile } from 'lucide-react'
import type { Category } from '@/types'
import { createCategory, updateCategory } from '@/db/queries'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { IconPicker } from '@/components/IconPicker/IconPicker'
import { ICON_REGISTRY } from '@/icons/registry'

interface Props {
  category?: Category          // edit mode when provided
  parentCategoryId?: number    // pre-set parent for "Add subcategory" context
  rootCategories?: Category[]  // when provided, shows parent picker in edit mode
  onClose: () => void
  onSaved: () => void
}

export function CategoryFormModal({ category, parentCategoryId, rootCategories, onClose, onSaved }: Props) {
  const isEdit = Boolean(category)
  const [name, setName] = useState(category?.name ?? '')
  const [icon, setIcon] = useState<string | undefined>(category?.icon)
  const [selectedParentId, setSelectedParentId] = useState<number | undefined>(
    category?.parent_category_id ?? parentCategoryId
  )
  const [showIconPicker, setShowIconPicker] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEscapeKey(showIconPicker ? () => setShowIconPicker(false) : onClose)

  // Root categories excluding self (can't be your own parent)
  const parentOptions = rootCategories?.filter(c => c.id !== category?.id) ?? []
  const showParentPicker = isEdit && parentOptions.length > 0

  async function handleSave() {
    const trimmed = name.trim()
    if (!trimmed) { setError('Name is required'); return }
    setSaving(true)
    try {
      if (isEdit && category) {
        await updateCategory(category.id, {
          name: trimmed,
          icon,
          parent_category_id: selectedParentId ?? null,
        })
      } else {
        await createCategory(trimmed, undefined, icon, selectedParentId)
      }
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  const SelectedIcon = icon ? ICON_REGISTRY[icon] : null

  const title = isEdit
    ? (category?.parent_category_id ? 'Edit subcategory' : 'Rename category')
    : parentCategoryId
      ? `Add subcategory`
      : 'Add category'

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm"
        onClick={e => { if (e.target === e.currentTarget) onClose() }}
      >
        <div className="w-full sm:max-w-sm bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl p-6 space-y-4 shadow-2xl border border-slate-200 dark:border-slate-700/50">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">{title}</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors">
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
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
            </div>
            <button
              type="button"
              onClick={() => setShowIconPicker(true)}
              className="h-[38px] w-[38px] flex items-center justify-center bg-slate-100 dark:bg-slate-700 rounded-lg border border-slate-200 dark:border-slate-600 hover:border-green-400/60 transition-colors text-slate-400 hover:text-green-400"
              title="Pick icon"
            >
              {SelectedIcon ? <SelectedIcon size={18} className="text-green-400" /> : <Smile size={16} />}
            </button>
          </div>

          {/* Parent picker — only in edit mode when root categories are available */}
          {showParentPicker && (
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                Parent category
              </label>
              <select
                value={selectedParentId ?? ''}
                onChange={e => setSelectedParentId(e.target.value ? Number(e.target.value) : undefined)}
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              >
                <option value="">None (root category)</option>
                {parentOptions.map(cat => (
                  <option key={cat.id} value={cat.id}>{cat.name}</option>
                ))}
              </select>
            </div>
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}

          <div className="flex gap-3">
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
    </>,
    document.body
  )
}
