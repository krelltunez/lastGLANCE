import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Smile, Users } from 'lucide-react'
import type { Category } from '@/types'
import { createCategory, updateCategory } from '@/db/queries'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useUsersContext } from '@/multiuser/UsersContext'
import { IconPicker } from '@/components/IconPicker/IconPicker'
import { ICON_REGISTRY } from '@/icons/registry'
import { useTranslation } from 'react-i18next'

interface Props {
  category?: Category          // edit mode when provided
  parentCategoryId?: number    // pre-set parent for "Add subcategory" context
  parentIcon?: string          // default icon when adding a subcategory
  rootCategories?: Category[]  // when provided, shows parent picker in edit mode
  onClose: () => void
  onSaved: () => void
}

export function CategoryFormModal({ category, parentCategoryId, parentIcon, rootCategories, onClose, onSaved }: Props) {
  const { t } = useTranslation()
  const { multiUserEnabled, users: allUsers } = useUsersContext()
  const isEdit = Boolean(category)
  const [name, setName] = useState(category?.name ?? '')
  const [icon, setIcon] = useState<string | undefined>(category ? category.icon : parentIcon)
  const [selectedParentId, setSelectedParentId] = useState<number | undefined>(
    category?.parent_category_id ?? parentCategoryId
  )
  const [assignedIds, setAssignedIds] = useState<string[]>(category?.assigned_user_sync_ids ?? [])
  const [showIconPicker, setShowIconPicker] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEscapeKey(showIconPicker ? () => setShowIconPicker(false) : onClose)

  function toggleAssigned(syncId: string) {
    setAssignedIds(ids => ids.includes(syncId) ? ids.filter(id => id !== syncId) : [...ids, syncId])
  }

  // Root categories excluding self (can't be your own parent)
  const parentOptions = rootCategories?.filter(c => c.id !== category?.id) ?? []
  const showParentPicker = isEdit && parentOptions.length > 0

  async function handleSave() {
    const trimmed = name.trim()
    if (!trimmed) { setError(t('categoryForm.nameRequired')); return }
    setSaving(true)
    try {
      if (isEdit && category) {
        await updateCategory(category.id, {
          name: trimmed,
          icon,
          parent_category_id: selectedParentId ?? null,
          assigned_user_sync_ids: assignedIds,
        })
      } else {
        await createCategory(trimmed, undefined, icon, selectedParentId, assignedIds)
      }
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  const SelectedIcon = icon ? ICON_REGISTRY[icon] : null

  const title = isEdit
    ? (category?.parent_category_id ? t('categoryForm.editSubcategory') : t('categoryForm.renameCategory'))
    : parentCategoryId
      ? t('categoryForm.addSubcategory')
      : t('categoryForm.addCategory')

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center app-safe-bottom bg-black/40 dark:bg-black/60 backdrop-blur-sm"
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
                placeholder={t('categoryForm.namePlaceholder')}
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
            </div>
            <button
              type="button"
              onClick={() => setShowIconPicker(true)}
              className="h-[38px] w-[38px] flex items-center justify-center bg-slate-100 dark:bg-slate-700 rounded-lg border border-slate-200 dark:border-slate-600 hover:border-green-400/60 transition-colors text-slate-400 hover:text-green-400"
              title={t('categoryForm.pickIcon')}
            >
              {SelectedIcon ? <SelectedIcon size={18} className="text-green-400" /> : <Smile size={16} />}
            </button>
          </div>

          {/* Parent picker — only in edit mode when root categories are available */}
          {showParentPicker && (
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                {t('categoryForm.parentCategory')}
              </label>
              <select
                value={selectedParentId ?? ''}
                onChange={e => setSelectedParentId(e.target.value ? Number(e.target.value) : undefined)}
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              >
                <option value="">{t('categoryForm.noParent')}</option>
                {parentOptions.map(cat => (
                  <option key={cat.id} value={cat.id}>{cat.name}</option>
                ))}
              </select>
            </div>
          )}

          {multiUserEnabled && allUsers.length > 0 && (
            <div className="pt-1 space-y-2">
              <div className="flex items-center gap-2">
                <Users size={13} className="text-slate-400 dark:text-slate-500" />
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('choreForm.assignedTo')}</span>
                <span className="text-xs text-slate-400 dark:text-slate-500">{t('choreForm.assignedHint')}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {allUsers.map(user => {
                  const active = assignedIds.includes(user.sync_id)
                  return (
                    <button
                      key={user.sync_id}
                      type="button"
                      onClick={() => toggleAssigned(user.sync_id)}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${
                        active
                          ? 'bg-green-400/15 border-green-400/50 text-green-500 dark:text-green-400'
                          : 'bg-slate-100 dark:bg-slate-700 border-slate-200 dark:border-slate-600 text-slate-500 dark:text-slate-400 hover:border-green-400/40 hover:text-green-500'
                      }`}
                    >
                      <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${active ? 'bg-green-400 text-white' : 'bg-slate-300 dark:bg-slate-500 text-slate-600 dark:text-slate-300'}`}>
                        {user.name.charAt(0).toUpperCase()}
                      </span>
                      {user.name}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {error && <p className="text-xs text-red-500">{error}</p>}

          <div className="flex gap-3">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
            >
              {t('categoryForm.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex-1 py-2.5 rounded-xl text-sm font-medium text-green-400 border border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60 disabled:opacity-50 transition-colors"
            >
              {saving ? t('categoryForm.saving') : isEdit ? t('categoryForm.save') : t('categoryForm.add')}
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
