import { useState } from 'react'
import { Pencil, Trash2, Plus } from 'lucide-react'
import type { CategoryWithChores } from '@/hooks/useChores'
import type { ChoreWithLastCompletion } from '@/types'
import { ChoreRow } from '@/components/ChoreRow/ChoreRow'
import { ChoreFormModal } from '@/components/ChoreFormModal/ChoreFormModal'
import { CategoryFormModal } from '@/components/CategoryFormModal/CategoryFormModal'
import { deleteCategory, deleteChore } from '@/db/queries'

interface Props {
  data: CategoryWithChores
  editMode: boolean
  onChoreTab: (chore: ChoreWithLastCompletion) => void
  onRefresh: () => void
}

export function CategorySection({ data, editMode, onChoreTab, onRefresh }: Props) {
  const [choreForm, setChoreForm] = useState<{ chore?: ChoreWithLastCompletion } | null>(null)
  const [categoryForm, setCategoryForm] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<'category' | number | null>(null)

  async function handleDeleteCategory() {
    await deleteCategory(data.category.id)
    onRefresh()
  }

  async function handleDeleteChore(id: number) {
    await deleteChore(id)
    onRefresh()
  }

  return (
    <>
      <div className="flex flex-col h-full">
        <div className="px-4 py-3 border-b border-slate-700/60 flex items-center justify-between gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400 truncate">
            {data.category.name}
          </h2>
          {editMode && (
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => setCategoryForm(true)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-700 transition-colors"
                aria-label="Rename category"
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={() => setConfirmDelete('category')}
                className="p-1.5 rounded-lg text-slate-400 hover:text-red-400 hover:bg-slate-700 transition-colors"
                aria-label="Delete category"
              >
                <Trash2 size={13} />
              </button>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-slate-700/40">
          {data.chores.length === 0 && !editMode && (
            <p className="px-4 py-6 text-sm text-slate-500 text-center">
              No chores yet — tap edit to add one.
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
            />
          ))}
          {editMode && (
            <button
              onClick={() => setChoreForm({})}
              className="w-full flex items-center gap-2 px-4 py-3 text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-700/40 transition-colors"
            >
              <Plus size={15} />
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
  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="w-full sm:max-w-sm bg-slate-800 rounded-t-2xl sm:rounded-2xl p-6 space-y-4 shadow-2xl border border-slate-700/50">
        <p className="text-sm text-slate-200">{message}</p>
        <p className="text-xs text-slate-400">This also removes all completion history.</p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-300 bg-slate-700 hover:bg-slate-600 transition-colors"
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
