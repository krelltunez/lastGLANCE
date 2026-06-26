import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Pencil, Trash2, Plus, Smile, GripVertical, ChevronDown, ChevronRight, ChevronUp, FolderPlus } from 'lucide-react'
import type { CategoryWithChores } from '@/hooks/useChores'
import type { Category, ChoreWithLastCompletion } from '@/types'
import { ChoreRow } from '@/components/ChoreRow/ChoreRow'
import { ChoreFormModal } from '@/components/ChoreFormModal/ChoreFormModal'
import { CategoryFormModal } from '@/components/CategoryFormModal/CategoryFormModal'
import { IconPicker } from '@/components/IconPicker/IconPicker'
import { deleteCategory, deleteChore, updateCategory, updateChore, reorderChores, reorderCategories } from '@/db/queries'
import { ICON_REGISTRY } from '@/icons/registry'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { getFillRatio, getCadenceColor } from '@/utils/cadence'
import { isInSeasonalWindow } from '@/utils/seasonal'
import { useTranslation } from 'react-i18next'

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

/**
 * Highest overdue ratio (elapsed / target, >= 1) among chores with a cadence.
 * Returns null when nothing is overdue. Used to show an at-a-glance dot on a
 * collapsed subcategory header so hidden overdue chores aren't missed.
 */
function maxOverdueRatio(chores: ChoreWithLastCompletion[]): number | null {
  let max: number | null = null
  for (const c of chores) {
    if (c.target_cadence_days === null || c.elapsed_days === null) continue
    const ratio = getFillRatio(c.elapsed_days, c.target_cadence_days)
    if (ratio >= 1 && (max === null || ratio > max)) max = ratio
  }
  return max
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
  isDropTarget?: boolean
  onExternalHover?: (categoryId: number | null) => void
  onCrossListDrop?: (choreId: number, targetCategoryId: number) => void
  hideEmptyState?: boolean
}

function ChoreList({
  category, allCategories, chores, editMode, onChoreTab, onRefresh, onLogged,
  wrapChores, isDropTarget, onExternalHover, onCrossListDrop, hideEmptyState,
}: ChoreListProps) {
  const { t } = useTranslation()
  const [choreForm, setChoreForm] = useState<{ chore?: ChoreWithLastCompletion } | null>(null)
  const [confirmDeleteChore, setConfirmDeleteChore] = useState<number | null>(null)
  const [localChores, setLocalChores] = useState<ChoreWithLastCompletion[]>(chores)
  const localChoresRef = useRef<ChoreWithLastCompletion[]>(chores)
  const [draggingId, setDraggingId] = useState<number | null>(null)
  const draggingIdRef = useRef<number | null>(null)
  const externalHoverRef = useRef<number | null>(null)
  const choreListRef = useRef<HTMLDivElement>(null)

  // Use a ref for callbacks so the drag useEffect never needs to re-run when
  // CategorySection re-renders (which happens whenever externalHoverTargetId changes).
  const cbRef = useRef({ onExternalHover, onCrossListDrop })
  useEffect(() => { cbRef.current = { onExternalHover, onCrossListDrop } })

  useEffect(() => {
    if (draggingIdRef.current === null) {
      setLocalChores(chores)
      localChoresRef.current = chores
    }
  }, [chores])

  useEffect(() => {
    if (draggingId === null) return

    function onMove(e: PointerEvent) {
      const listEl = choreListRef.current
      if (!listEl) return

      const ownRect = listEl.getBoundingClientRect()
      const insideOwn = (
        e.clientX >= ownRect.left && e.clientX <= ownRect.right &&
        e.clientY >= ownRect.top  && e.clientY <= ownRect.bottom
      )

      if (!insideOwn) {
        // Find which drop target the pointer is over
        const el = document.elementFromPoint(e.clientX, e.clientY)
        const targetEl = el?.closest('[data-cat-droptarget-id]') as HTMLElement | null
        const targetId = targetEl ? Number(targetEl.getAttribute('data-cat-droptarget-id')) : null
        const externalId = (targetId !== null && targetId !== category.id) ? targetId : null
        if (externalId !== externalHoverRef.current) {
          externalHoverRef.current = externalId
          cbRef.current.onExternalHover?.(externalId)
        }
        return
      }

      // Back inside own list — clear external hover
      if (externalHoverRef.current !== null) {
        externalHoverRef.current = null
        cbRef.current.onExternalHover?.(null)
      }

      // Same-list reorder
      const rows = Array.from(listEl.querySelectorAll('[data-chore-id]'))
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
      const choreId = draggingIdRef.current
      const externalTarget = externalHoverRef.current

      externalHoverRef.current = null
      cbRef.current.onExternalHover?.(null)
      draggingIdRef.current = null
      setDraggingId(null)

      if (choreId === null) return

      if (externalTarget !== null) {
        // Optimistically remove from this list before the refresh
        const without = localChoresRef.current.filter(c => c.id !== choreId)
        localChoresRef.current = without
        setLocalChores(without)
        cbRef.current.onCrossListDrop?.(choreId, externalTarget)
      } else {
        await reorderChores(localChoresRef.current.map(c => c.id!))
        onRefresh()
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [draggingId, onRefresh, category.id])

  function startDrag(e: React.PointerEvent, choreId: number) {
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingIdRef.current = choreId
    setDraggingId(choreId)
  }

  const visibleChores = editMode ? localChores : localChores.filter(c => isInSeasonalWindow(c))

  return (
    <>
      <div
        ref={choreListRef}
        data-cat-droptarget-id={category.id}
        className={`rounded-xl ${wrapChores ? 'flex flex-wrap gap-2' : 'flex flex-col gap-2'}`}
      >
        {localChores.length === 0 && !editMode && !isDropTarget && !hideEmptyState && (
          <p className="text-sm text-slate-400 dark:text-slate-600 py-3 text-center">
            {t('categorySection.noChores')}
          </p>
        )}
        {localChores.length > 0 && visibleChores.length === 0 && !editMode && (
          <p className="text-sm text-slate-400 dark:text-slate-600 py-3 text-center">
            {t('categorySection.hiddenSeasonal', { count: localChores.length })}
          </p>
        )}
        {visibleChores.map(chore => (
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
        {isDropTarget && (
          <div className="flex items-center justify-center py-1.5 px-3 rounded-lg text-xs text-green-400 border border-dashed border-green-400/50 bg-green-400/5 pointer-events-none">
            {t('categorySection.dropHere')}
          </div>
        )}
        {editMode && (
          <button
            onClick={() => setChoreForm({})}
            className={`flex items-center gap-2 px-3 py-2.5 rounded-xl text-sm text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700/40 border border-dashed border-slate-300 dark:border-slate-700/60 hover:border-slate-400 dark:hover:border-slate-600 transition-colors${wrapChores ? ' min-w-0 min-[480px]:max-w-[calc(50%_-_4px)]' : ''}`}
            style={wrapChores ? { flex: '1 1 320px' } : undefined}
          >
            <Plus size={14} />
            {t('categorySection.addChore')}
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
          message={t('categorySection.deleteChoreConfirm', { name: localChores.find(c => c.id === confirmDeleteChore)?.name ?? '' })}
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
  isDropTarget: boolean
  onExternalHover: (categoryId: number | null) => void
  onCrossListDrop: (choreId: number, targetCategoryId: number) => void
  compact?: boolean
  onMoveUp?: () => void
  onMoveDown?: () => void
}

function SubcategorySection({
  data, allCategories, rootCategories, editMode, onChoreTab, onRefresh, onLogged,
  wrapChores, collapsed, onToggleCollapse, isDropTarget, onExternalHover, onCrossListDrop, compact,
  onMoveUp, onMoveDown,
}: SubcategorySectionProps) {
  const { t } = useTranslation()
  const [catForm, setCatForm] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [iconPicker, setIconPicker] = useState(false)

  const SubIcon = data.category.icon ? ICON_REGISTRY[data.category.icon] : null

  // When collapsed, surface a dot if any (in-season) chore is overdue, so it
  // isn't hidden. Colour matches the most-overdue chore (amber → red).
  const overdueRatio = collapsed
    ? maxOverdueRatio(editMode ? data.chores : data.chores.filter(c => isInSeasonalWindow(c)))
    : null

  return (
    <div
      data-cat-droptarget-id={data.category.id}
      className={`${compact ? 'mt-2' : 'mt-4'} border-t border-slate-100 dark:border-slate-700/40 pt-3`}
    >
      {/* Subcategory header */}
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={onToggleCollapse}
          className="shrink-0 text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
          aria-label={collapsed ? t('categorySection.expand') : t('categorySection.collapse')}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>

        {editMode && (
          <button
            onClick={() => setIconPicker(true)}
            className="shrink-0 p-1 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors text-slate-400 dark:text-slate-500 hover:text-green-400"
            title={t('categorySection.changeIcon')}
          >
            {SubIcon
              ? <SubIcon size={14} className="text-green-400" />
              : <Smile size={13} />}
          </button>
        )}

        {!editMode && SubIcon && (
          <SubIcon size={14} className="text-green-400 shrink-0" />
        )}

        <div className="flex-1 flex items-center gap-2 min-w-0">
          <h3 className="text-sm font-semibold text-slate-600 dark:text-slate-300 tracking-tight truncate">
            {data.category.name}
          </h3>
          {overdueRatio !== null && (
            <span
              className="shrink-0 w-2 h-2 rounded-full"
              style={{ backgroundColor: getCadenceColor(overdueRatio) }}
              role="img"
              aria-label={t('categorySection.overdueHidden')}
              title={t('categorySection.overdueHidden')}
            />
          )}
        </div>

        {isDropTarget && collapsed && (
          <span className="shrink-0 px-2 py-0.5 rounded text-xs text-green-400 border border-dashed border-green-400/50 bg-green-400/5">
            {t('categorySection.dropHere')}
          </span>
        )}

        {editMode && (
          <div className="flex items-center gap-1 shrink-0">
            {onMoveUp && (
              <button
                onClick={onMoveUp}
                className="p-1 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                aria-label={t('categorySection.moveSubUp')}
              >
                <ChevronUp size={12} />
              </button>
            )}
            {onMoveDown && (
              <button
                onClick={onMoveDown}
                className="p-1 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                aria-label={t('categorySection.moveSubDown')}
              >
                <ChevronDown size={12} />
              </button>
            )}
            <button
              onClick={() => setCatForm(true)}
              className="p-1 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              aria-label={t('categorySection.renameSubcategory')}
            >
              <Pencil size={12} />
            </button>
            <button
              onClick={() => setConfirmDelete(true)}
              className="p-1 rounded-lg text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              aria-label={t('categorySection.deleteSubcategory')}
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
            isDropTarget={isDropTarget}
            onExternalHover={onExternalHover}
            onCrossListDrop={onCrossListDrop}
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
          message={t('categorySection.deleteSubConfirm', { name: data.category.name })}
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
  const { t } = useTranslation()
  const [categoryForm, setCategoryForm] = useState(false)
  const [addingSubcategory, setAddingSubcategory] = useState(false)
  const [confirmDeleteCategory, setConfirmDeleteCategory] = useState(false)
  const [iconPickerOpen, setIconPickerOpen] = useState(false)
  const lsKey = `lastglance-collapsed-subs-${data.category.id}`
  const [collapsedSubs, setCollapsedSubs] = useState<Set<number>>(() => {
    try {
      const stored = localStorage.getItem(lsKey)
      if (stored) return new Set(JSON.parse(stored) as number[])
    } catch { /* ignore malformed stored value */ }
    return new Set()
  })

  useEffect(() => {
    if (collapsedSubs.size === 0) localStorage.removeItem(lsKey)
    else localStorage.setItem(lsKey, JSON.stringify([...collapsedSubs]))
  }, [collapsedSubs, lsKey])
  const [externalHoverTargetId, setExternalHoverTargetId] = useState<number | null>(null)

  function toggleSubCollapse(id: number) {
    setCollapsedSubs(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  async function handleCrossListDrop(choreId: number, targetCategoryId: number) {
    await updateChore(choreId, { category_id: targetCategoryId })
    // Auto-expand if the target subcategory was collapsed
    setCollapsedSubs(prev => {
      if (prev.has(targetCategoryId)) {
        const next = new Set(prev)
        next.delete(targetCategoryId)
        return next
      }
      return prev
    })
    onRefresh()
  }

  const rootCategories = allCategories?.filter(c => !c.parent_category_id) ?? []
  const CategoryIcon = data.category.icon ? ICON_REGISTRY[data.category.icon] : null

  const hasSubcategories = data.subcategories.length > 0
  const deleteMessage = hasSubcategories
    ? t('categorySection.deleteCategoryWithSubsConfirm', { name: data.category.name })
    : t('categorySection.deleteCategoryConfirm', { name: data.category.name })

  return (
    <>
      <div
        data-cat-droptarget-id={data.category.id}
        className="flex flex-col"
        style={{ opacity: isCategoryDragging ? 0.4 : 1 }}
      >
        {/* Category header */}
        <div className={`flex items-center gap-2.5 ${data.chores.length === 0 && data.subcategories.length > 0 ? 'mb-1.5' : 'mb-3'}`}>
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
              aria-label={t('categorySection.changeCategoryIcon')}
              title={t('categorySection.changeIcon')}
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
                aria-label={t('categoryForm.addSubcategory')}
                title={t('categoryForm.addSubcategory')}
              >
                <FolderPlus size={13} />
              </button>
              <button
                onClick={() => setCategoryForm(true)}
                className="p-1.5 rounded-lg text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                aria-label={t('categorySection.renameCategory')}
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={() => setConfirmDeleteCategory(true)}
                className="p-1.5 rounded-lg text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                aria-label={t('categorySection.deleteCategory')}
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
          isDropTarget={externalHoverTargetId === data.category.id}
          onExternalHover={setExternalHoverTargetId}
          onCrossListDrop={handleCrossListDrop}
          hideEmptyState={data.subcategories.length > 0}
        />

        {/* Subcategory sections */}
        {data.subcategories.map((sub, idx) => (
          <SubcategorySection
            key={sub.category.id}
            data={sub}
            compact={idx === 0 && data.chores.length === 0}
            allCategories={allCategories}
            rootCategories={rootCategories}
            editMode={editMode}
            onChoreTab={onChoreTab}
            onRefresh={onRefresh}
            onLogged={onLogged}
            wrapChores={wrapChores}
            collapsed={collapsedSubs.has(sub.category.id)}
            onToggleCollapse={() => toggleSubCollapse(sub.category.id)}
            isDropTarget={externalHoverTargetId === sub.category.id}
            onExternalHover={setExternalHoverTargetId}
            onCrossListDrop={handleCrossListDrop}
            onMoveUp={idx > 0 ? async () => {
              const ids = data.subcategories.map(s => s.category.id)
              ;[ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]]
              await reorderCategories(ids)
              onRefresh()
            } : undefined}
            onMoveDown={idx < data.subcategories.length - 1 ? async () => {
              const ids = data.subcategories.map(s => s.category.id)
              ;[ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]]
              await reorderCategories(ids)
              onRefresh()
            } : undefined}
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
          parentIcon={data.category.icon}
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
  const { t } = useTranslation()
  useEscapeKey(onCancel)
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="w-full sm:max-w-sm bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl p-6 space-y-4 shadow-2xl border border-slate-200 dark:border-slate-700/50">
        <p className="text-sm text-slate-800 dark:text-slate-200">{message}</p>
        <p className="text-xs text-slate-500 dark:text-slate-400">{t('categorySection.alsoRemovesHistory')}</p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
          >
            {t('categorySection.cancel')}
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white bg-red-500 hover:bg-red-400 transition-colors"
          >
            {t('categorySection.delete')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
