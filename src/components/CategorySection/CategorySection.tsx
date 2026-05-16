import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Pencil, Trash2, Plus, Smile, GripVertical, ChevronDown, ChevronRight, FolderPlus } from 'lucide-react'
import type { CategoryWithChores } from '@/hooks/useChores'
import type { Category, ChoreWithLastCompletion } from '@/types'
import { ChoreRow } from '@/components/ChoreRow/ChoreRow'
import { ChoreFormModal } from '@/components/ChoreFormModal/ChoreFormModal'
import { CategoryFormModal } from '@/components/CategoryFormModal/CategoryFormModal'
import { IconPicker } from '@/components/IconPicker/IconPicker'
import { deleteCategory, deleteChore, updateCategory, reorderChores } from '@/db/queries'
import { ICON_REGISTRY } from '@/icons/registry'
import { useEscapeKey } from '@/hooks/useEscapeKey'

interface Props {
  data: CategoryWithChores
  allCategories?: Category[]
  editMode: boolean
  onChoreTab: (chore: ChoreWithLastCompletion) => void
  onRefresh: () => void
  onLogged?: () => void
  onCategoryDragHandlePointerDown?: (e: React.PointerEvent) => void
  isCategoryDragging?: boolean
  wrapChores?: boolean
}

// ── ChoreList ─────────────────────────────────────────────────────────────────

interface ChoreListProps {
  category: Category
  allCategories?: Category[]
  chores: ChoreWithLastCompletion[]
  editMode: boolean
  onChoreTab: (chore: ChoreWithLastCompletion) => void
  onRefresh: () => void
  onLogged?: () => void
  wrapChores?: boolean
}

function ChoreList({ category, allCategories, chores, editMode, onChoreTab, onRefresh, onLogged, wrapChores }: ChoreListProps) {
  const [choreForm, setChoreForm] = useState<{ chore?: ChoreWithLastCompletion } | null>(null)
  const [confirmDeleteChore, setConfirmDeleteChore] = useState<number | null>(null)
  const [localChores, setLocalChores] = useState<ChoreWithLastCompletion[]>(chores)
  const localChoresRef = useRef<ChoreWithLastCompletion[]>(chores)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const draggingIdRef = useRef<number | null>(null)
  const choreListRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (draggingIdRef.current === null) {
      setLocalChores(chores)
      localChoresRef.current = chores
    }
  }, [chores])

  useEffect(() => {
    if (draggingId === null) return

    function onMove(e: PointerEvent) {
      const rows = Array.from(choreListRef.current?.querySelectorAll('[data-chore-id]') ?? [])
      if (rows.length === 0) return

      let hoverIdx = rows.length
      for (let i = 0; i < rows.length; i++) {
        const rect = rows[i].getBoundingClientRect()
        if (e.clientY < rect.top + rect.height / 2) { hoverIdx = i; break }
      }

      const cur = localChoresRef.current
      const fromIdx = cur.findIndex(c => c.id === draggingIdRef.current)
      if (fromIdx === -1) return

      const next = [...cur]
      const [item] = next.splice(fromIdx, 1)
      const insertIdx = Math.max(0, Math.min(hoverIdx > fromIdx ? hoverIdx - 1 : hoverIdx, next.length))
      next.splice(insertIdx, 0, item)

      if (next.some((c, i) => c.id !== cur[i].id)) {
        localChoresRef.current = next
        setLocalChores(next)
      }
    }

    async function onUp() {
      if (draggingIdRef.current !== null) {
        await reorderChores(localChoresRef.current.map(c => c.id!))
        onRefresh()
      }
      draggingIdRef.current = null
      setDraggingId(null)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [draggingId, onRefresh])

  function startDrag(e: React.PointerEvent, choreId: number) {
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingIdRef.current = choreId
    setDraggingId(choreId)
  }

  return (
    <>
      <div
        ref={choreListRef}
        className={wrapChores ? 'flex flex-wrap gap-2' : 'flex flex-col gap-2'}
      >
        {localChores.length === 0 && !editMode && (
          <p className="text-sm text-slate-400 dark:text-slate-600 py-3 text-center">
            No chores yet — tap Edit to add one.
          </p>
        )}
        {localChores.map(chore => (
          <div
            key={chore.id}
            data-chore-id={chore.id}
            className={wrapChores ? 'min-w-0 min-[480px]:max-w-[calc(50%_-_4px)]' : undefined}
            style={wrapChores ? { flex: '1 1 320px' } : undefined}
          >
            <ChoreRow
              chore={chore}
              editMode={editMode}
              onTap={onChoreTab}
              onEdit={() => setChoreForm({ chore })}
              onDelete={() => setConfirmDeleteChore(chore.id)}
              onRefresh={() => { onRefresh(); onLogged?.() }}
              onDragHandlePointerDown={e => startDrag(e, chore.id!)}
              isDragging={draggingId === chore.id}
            />
          </div>
        ))}
        {editMode && (
          <button
            onClick={() => setChoreForm({})}
            className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700/40 border border-dashed border-slate-300 dark:border-slate-700/60 hover:border-slate-400 dark:hover:border-slate-600 transition-colors${wrapChores ? ' min-w-0 min-[480px]:max-w-[calc(50%_-_4px)]' : ''}`}
            style={wrapChores ? { flex: '1 1 320px' } : undefined}
          >
            <Plus size={14} />
            Add chore
          </button>
        )}
      </div>

      {choreForm !== null && (
        <ChoreFormModal
          category={category}
          allCategories={allCategories}
          chore={choreForm.chore}
          onClose={() => setChoreForm(null)}
          onSaved={() => { setChoreForm(null); onRefresh() }}
        />
      )}

      {confirmDeleteChore !== null && (
        <ConfirmDialog
          message={`Delete "${localChores.find(c => c.id === confirmDeleteChore)?.name}"?`}
          onConfirm={async () => {
            await deleteChore(confirmDeleteChore)
            setConfirmDeleteChore(null)
            onRefresh()
          }}
          onCancel={() => setConfirmDeleteChore(null)}
        />
      )}
    </>
  )
}

// ── SubcategorySection ────────────────────────────────────────────────────────

interface SubcategorySectionProps {
  data: CategoryWithChores
  allCategories?: Category[]
  rootCategories: Category[]
  editMode: boolean
  onChoreTab: (chore: ChoreWithLastCompletion) => void
  onRefresh: () => void
  onLogged?: () => void
  wrapChores?: boolean
  collapsed: boolean
  onToggleCollapse: () => void
}

function SubcategorySection({
  data, allCategories, rootCategories, editMode, onChoreTab, onRefresh, onLogged,
  wrapChores, collapsed, onToggleCollapse,
}: SubcategorySectionProps) {
  const [catForm, setCatForm] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [iconPicker, setIconPicker] = useState(false)

  const SubIcon = data.category.icon ? ICON_REGISTRY[data.category.icon] : null

  return (
    <div className="mt-4 border-t border-slate-100 dark:border-slate-700/40 pt-3">
      {/* Subcategory header */}
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={onToggleCollapse}
          className="shrink-0 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
          aria-label={collapsed ? 'Expand' : 'Collapse'}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>

        {editMode && (
          <button
            onClick={() => setIconPicker(true)}
            className="shrink-0 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors text-slate-400 dark:text-slate-500 hover:text-green-400"
            title="Change icon"
          >
            {SubIcon
              ? <SubIcon size={14} className="text-green-400" />
              : <Smile size={13} />}
          </button>
        )}

        {!editMode && SubIcon && (
          <SubIcon size={14} className="text-green-400 shrink-0" />
        )}

        <h3 className="text-sm font-semibold text-slate-600 dark:text-slate-300 tracking-tight truncate flex-1">
          {data.category.name}
        </h3>

        {editMode && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setCatForm(true)}
              className="p-1 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              aria-label="Rename subcategory"
            >
              <Pencil size={12} />
            </button>
            <button
              onClick={() => setConfirmDelete(true)}
              className="p-1 rounded-lg text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              aria-label="Delete subcategory"
            >
              <Trash2 size={12} />
            </button>
          </div>
        )}
      </div>

      {!collapsed && (
        <div className="pl-4">
          <ChoreList
            category={data.category}
            allCategories={allCategories}
            chores={data.chores}
            editMode={editMode}
            onChoreTab={onChoreTab}
            onRefresh={onRefresh}
            onLogged={onLogged}
            wrapChores={wrapChores}
          />
        </div>
      )}

      {catForm && (
        <CategoryFormModal
          category={data.category}
          rootCategories={rootCategories}
          onClose={() => setCatForm(false)}
          onSaved={() => { setCatForm(false); onRefresh() }}
        />
      )}

      {iconPicker && (
        <IconPicker
          selected={data.category.icon}
          onSelect={async (name) => {
            await updateCategory(data.category.id, { icon: name ?? '' })
            onRefresh()
          }}
          onClose={() => setIconPicker(false)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          message={`Delete "${data.category.name}" and all its chores?`}
          onConfirm={async () => {
            await deleteCategory(data.category.id)
            setConfirmDelete(false)
            onRefresh()
          }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </div>
  )
}

// ── CategorySection ───────────────────────────────────────────────────────────

export function CategorySection({
  data, allCategories, editMode, onChoreTab, onRefresh, onLogged,
  onCategoryDragHandlePointerDown, isCategoryDragging, wrapChores,
}: Props) {
  const [categoryForm, setCategoryForm] = useState(false)
  const [addingSubcategory, setAddingSubcategory] = useState(false)
  const [confirmDeleteCategory, setConfirmDeleteCategory] = useState(false)
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  const [collapsedSubs, setCollapsedSubs] = useState<Set<number>>(new Set())

  function toggleSubCollapse(id: number) {
    setCollapsedSubs(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const rootCategories = allCategories?.filter(c => !c.parent_category_id) ?? []
  const CategoryIcon = data.category.icon ? ICON_REGISTRY[data.category.icon] : null

  const hasSubcategories = data.subcategories.length > 0
  const deleteMessage = hasSubcategories
    ? `Delete "${data.category.name}" and all its chores and subcategories?`
    : `Delete "${data.category.name}" and all its chores?`

  return (
    <>
      <div className="flex flex-col" style={{ opacity: isCategoryDragging ? 0.4 : 1 }}>
        {/* Category header */}
        <div className="flex items-center gap-2.5 mb-3">
          {editMode && onCategoryDragHandlePointerDown && (
            <div
              className="shrink-0 cursor-grab active:cursor-grabbing text-slate-300 dark:text-slate-600 hover:text-slate-400 dark:hover:text-slate-500"
              style={{ touchAction: 'none' }}
              onPointerDown={onCategoryDragHandlePointerDown}
            >
              <GripVertical size={14} />
            </div>
          )}
          {editMode && (
            <button
              onClick={() => setIconPickerOpen(true)}
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
                onClick={() => setAddingSubcategory(true)}
                className="p-1.5 rounded-lg text-slate-400 dark:text-slate-500 hover:text-green-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                aria-label="Add subcategory"
                title="Add subcategory"
              >
                <FolderPlus size={13} />
              </button>
              <button
                onClick={() => setCategoryForm(true)}
                className="p-1.5 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                aria-label="Rename category"
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={() => setConfirmDeleteCategory(true)}
                className="p-1.5 rounded-lg text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                aria-label="Delete category"
              >
                <Trash2 size={13} />
              </button>
            </div>
          )}
        </div>

        {/* Root chore list */}
        <ChoreList
          category={data.category}
          allCategories={allCategories}
          chores={data.chores}
          editMode={editMode}
          onChoreTab={onChoreTab}
          onRefresh={onRefresh}
          onLogged={onLogged}
          wrapChores={wrapChores}
        />

        {/* Subcategory sections */}
        {data.subcategories.map(sub => (
          <SubcategorySection
            key={sub.category.id}
            data={sub}
            allCategories={allCategories}
            rootCategories={rootCategories}
            editMode={editMode}
            onChoreTab={onChoreTab}
            onRefresh={onRefresh}
            onLogged={onLogged}
            wrapChores={wrapChores}
            collapsed={collapsedSubs.has(sub.category.id)}
            onToggleCollapse={() => toggleSubCollapse(sub.category.id)}
          />
        ))}


      </div>

      {categoryForm && (
        <CategoryFormModal
          category={data.category}
          rootCategories={rootCategories}
          onClose={() => setCategoryForm(false)}
          onSaved={() => { setCategoryForm(false); onRefresh() }}
        />
      )}

      {addingSubcategory && (
        <CategoryFormModal
          parentCategoryId={data.category.id}
          onClose={() => setAddingSubcategory(false)}
          onSaved={() => { setAddingSubcategory(false); onRefresh() }}
        />
      )}

      {iconPickerOpen && (
        <IconPicker
          selected={data.category.icon}
          onSelect={async (name) => {
            await updateCategory(data.category.id, { icon: name ?? '' })
            onRefresh()
          }}
          onClose={() => setIconPickerOpen(false)}
        />
      )}

      {confirmDeleteCategory && (
        <ConfirmDialog
          message={deleteMessage}
          onConfirm={async () => {
            await deleteCategory(data.category.id)
            setConfirmDeleteCategory(false)
            onRefresh()
          }}
          onCancel={() => setConfirmDeleteCategory(false)}
        />
      )}
    </>
  )
}

// ── ConfirmDialog ─────────────────────────────────────────────────────────────

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
  return createPortal(
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
    </div>,
    document.body
  )
}
