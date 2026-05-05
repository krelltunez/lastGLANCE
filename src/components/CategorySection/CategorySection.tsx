import { useState } from 'react'
import { Pencil, Trash2, Plus, Smile } from 'lucide-react'
import type { CategoryWithChores } from '@/hooks/useChores'
import type { ChoreWithLastCompletion } from '@/types'
import { ChoreRow } from '@/components/ChoreRow/ChoreRow'
import { ChoreFormModal } from '@/components/ChoreFormModal/ChoreFormModal'
import { CategoryFormModal } from '@/components/CategoryFormModal/CategoryFormModal'
import { IconPicker } from '@/components/IconPicker/IconPicker'
import { deleteCategory, deleteChore, updateCategory } from '@/db/queries'
import { ICON_REGISTRY } from '@/icons/registry'
import { useEscapeKey } from '@/hooks/useEscapeKey'

interface Props {
  data: CategoryWithChores
  editMode: boolean
  onChoreTab: (chore: ChoreWithLastCompletion) => void
  onRefresh: () => void
  onLogged?: () => void
}

export function CategorySection({ data, editMode, onChoreTab, onRefresh, onLogged }: Props) {
  const [choreForm, setChoreForm] = useState<{ chore?: ChoreWithLastCompletion } | null>(null)
  const [categoryForm, setCategoryForm] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<'category' | number | null>(null)
  const [iconPickerFor, setIconPickerFor] = useState<'category' | number | null>(null)

  async function handleDeleteCategory() {
    await deleteCategory(data.category.id)
    onRefresh()
  }

  async function handleDeleteChore(id: number) {
    await deleteChore(id)
    onRefresh()
  }

  async function handleCategoryIconSelect(iconName: string | undefined) {
    await updateCategory(data.category.id, { icon: iconName ?? '' })
    onRefresh()
  }

  const CategoryIcon = data.category.icon ? ICON_REGISTRY[data.category.icon] : null

  return (
    <>
      <div className="flex flex-col">
        {/* Category header */}
        <div className="flex items-center gap-2.5 mb-3">
          {editMode && (
            <button
              onClick={() => setIconPickerFor('category')}
              className="shrink-0 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors text-slate-400 dark:text-slate-500 hover:text-green-400"
              aria-label="Change category icon"
              title="Change icon"
            >
              {CategoryIcon
                ? <CategoryIcon size={18} className="text-green-400" />
                : <Smile size={16} />}
            </button>
          )}

          {!editMode && CategoryIcon && (
            <CategoryIcon size={18} className="text-green-400 shrink-0" />
          )}

          <h2 className="text-base font-bold text-green-400 tracking-tight truncate flex-1">
            {data.category.name}
          </h2>

          {editMode && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => setCategoryForm(true)}
                className="p-1.5 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                aria-label="Rename category"
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={() => setConfirmDelete('category')}
                className="p-1.5 rounded-lg text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                aria-label="Delete category"
              >
                <Trash2 size={13} />
              </button>
            </div>
          )}
        </div>

        {/* Chore list */}
        <div className="flex flex-col gap-2">
          {data.chores.length === 0 && !editMode && (
            <p className="text-sm text-slate-400 dark:text-slate-600 py-3 text-center">
              No chores yet — tap Edit to add one.
            </p>
          )}
          {data.chores.map(chore => (
            <ChoreRow
              key={chore.id}
              chore={chore}
              editMode={editMode}
              onTap={onChoreTab}
              onEdit={() => setChoreForm({ chore })}
              onDelete={() => setConfirmDelete(chore.id)}
              onRefresh={() => { onRefresh(); onLogged?.() }}
            />
          ))}
          {editMode && (
            <button
              onClick={() => setChoreForm({})}
              className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700/40 border border-dashed border-slate-300 dark:border-slate-700/60 hover:border-slate-400 dark:hover:border-slate-600 transition-colors"
            >
              <Plus size={14} />
              Add chore
            </button>
          )}
        </div>
      </div>

      {choreForm !== null && (
        <ChoreFormModal
          category={data.category}
          chore={choreForm.chore}
          onClose={() => setChoreForm(null)}
          onSaved={() => { setChoreForm(null); onRefresh() }}
        />
      )}

      {categoryForm && (
        <CategoryFormModal
          category={data.category}
          onClose={() => setCategoryForm(false)}
          onSaved={() => { setCategoryForm(false); onRefresh() }}
        />
      )}

      {iconPickerFor === 'category' && (
        <IconPicker
          selected={data.category.icon}
          onSelect={handleCategoryIconSelect}
          onClose={() => setIconPickerFor(null)}
        />
      )}

      {confirmDelete !== null && (
        <ConfirmDialog
          message={
            confirmDelete === 'category'
              ? `Delete "${data.category.name}" and all its chores?`
              : `Delete "${data.chores.find(c => c.id === confirmDelete)?.name}"?`
          }
          onConfirm={() => {
            if (confirmDelete === 'category') handleDeleteCategory()
            else handleDeleteChore(confirmDelete)
            setConfirmDelete(null)
          }}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </>
  )
}

function ConfirmDialog({
  message,
  onConfirm,
  onCancel,
}: {
  message: string
  onConfirm: () => void
  onCancel: () => void
}) {
  useEscapeKey(onCancel)
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="w-full sm:max-w-sm bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl p-6 space-y-4 shadow-2xl border border-slate-200 dark:border-slate-700/50">
        <p className="text-sm text-slate-800 dark:text-slate-200">{message}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">This also removes all completion history.</p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white bg-red-500 hover:bg-red-400 transition-colors"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
