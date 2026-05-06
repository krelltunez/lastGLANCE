import { useState, useRef, useEffect } from 'react'
import { Plus } from 'lucide-react'
import { useChores } from '@/hooks/useChores'
import { CategorySection } from '@/components/CategorySection/CategorySection'
import { LogModal } from '@/components/LogModal/LogModal'
import { CategoryFormModal } from '@/components/CategoryFormModal/CategoryFormModal'
import type { ChoreWithLastCompletion } from '@/types'

interface Props {
  editMode: boolean
  onLogged?: () => void
}

const SNAP_MS = 280

export function Ribbon({ editMode, onLogged }: Props) {
  const { data, loading, refresh } = useChores()
  const [activeCategoryIndex, setActiveCategoryIndex] = useState(0)
  const [selectedChore, setSelectedChore] = useState<ChoreWithLastCompletion | null>(null)
  const [addingCategory, setAddingCategory] = useState(false)

  // Swipe
  const [offset, setOffset] = useState(0)
  const [snapping, setSnapping] = useState(false)
  const isDragging = useRef(false)
  const touchStartX = useRef(0)
  const touchStartY = useRef(0)
  const liveOffset = useRef(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = tabsRef.current?.children[activeCategoryIndex] as HTMLElement | undefined
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [activeCategoryIndex])

  function handleTouchStart(e: React.TouchEvent) {
    if (snapping) return
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
    isDragging.current = false
    liveOffset.current = 0
  }

  function handleTouchMove(e: React.TouchEvent) {
    if (snapping) return
    const dx = e.touches[0].clientX - touchStartX.current
    const dy = e.touches[0].clientY - touchStartY.current
    if (!isDragging.current) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return
      if (Math.abs(dy) > Math.abs(dx)) return
      isDragging.current = true
    }
    const atStart = activeCategoryIndex === 0 && dx > 0
    const atEnd = activeCategoryIndex === data.length - 1 && dx < 0
    const newOffset = (atStart || atEnd) ? dx * 0.2 : dx
    liveOffset.current = newOffset
    setOffset(newOffset)
  }

  function snap(targetOffset: number, afterSnap?: () => void) {
    setSnapping(true)
    setOffset(targetOffset)
    setTimeout(() => {
      afterSnap?.()
      setOffset(0)
      liveOffset.current = 0
      setSnapping(false)
    }, SNAP_MS)
  }

  function handleTouchEnd() {
    if (!isDragging.current) return
    isDragging.current = false
    const W = containerRef.current?.offsetWidth ?? 375
    const cur = liveOffset.current
    const threshold = W * 0.28

    if (cur < -threshold && activeCategoryIndex < data.length - 1) {
      snap(-W, () => setActiveCategoryIndex(i => i + 1))
    } else if (cur > threshold && activeCategoryIndex > 0) {
      snap(W, () => setActiveCategoryIndex(i => i - 1))
    } else {
      snap(0)
    }
  }

  function handleTouchCancel() {
    if (!isDragging.current) return
    isDragging.current = false
    snap(0)
  }

  function openChore(chore: ChoreWithLastCompletion) { setSelectedChore(chore) }
  function closeChore() { setSelectedChore(null) }
  function afterLog() { refresh(); onLogged?.() }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-slate-400 dark:text-slate-500 text-sm">Loading…</div>
      </div>
    )
  }

  const showEmpty = data.length === 0

  const prevData = activeCategoryIndex > 0 ? data[activeCategoryIndex - 1] : null
  const currData = data[activeCategoryIndex]
  const nextData = activeCategoryIndex < data.length - 1 ? data[activeCategoryIndex + 1] : null

  return (
    <>
      {/* ── Mobile: one category at a time with tab strip ── */}
      <div className="flex flex-col flex-1 overflow-hidden lg:hidden">
        {!showEmpty && (
          <div ref={tabsRef} className="flex overflow-x-auto scrollbar-none border-b border-slate-200 dark:border-slate-700/60 bg-slate-100 dark:bg-slate-900 shrink-0">
            {data.map((d, i) => (
              <button
                key={d.category.id}
                onClick={() => setActiveCategoryIndex(i)}
                className={`
                  shrink-0 px-4 py-2.5 text-xs font-semibold transition-colors whitespace-nowrap
                  ${i === activeCategoryIndex
                    ? 'text-green-400 border-b-2 border-green-400'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'}
                `}
              >
                {d.category.name}
              </button>
            ))}
          </div>
        )}

        {showEmpty ? (
          <div className="flex-1">
            <EmptyState onAdd={() => setAddingCategory(true)} />
          </div>
        ) : (
          <div
            ref={containerRef}
            className="flex-1 overflow-hidden"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onTouchCancel={handleTouchCancel}
            style={{ touchAction: 'pan-y' }}
          >
            {/* Three-panel track: [prev][current][next] */}
            <div
              className="flex h-full"
              style={{
                width: '300%',
                transform: `translateX(calc(-33.333% + ${offset}px))`,
                transition: snapping ? `transform ${SNAP_MS}ms cubic-bezier(0.25, 1, 0.5, 1)` : 'none',
                willChange: 'transform',
              }}
            >
              <div className="overflow-y-auto" style={{ width: '33.333%' }}>
                {prevData && <div className="p-4"><CategorySection data={prevData} editMode={editMode} onChoreTab={openChore} onRefresh={refresh} onLogged={onLogged} /></div>}
              </div>
              <div className="overflow-y-auto" style={{ width: '33.333%' }}>
                {currData && <div className="p-4"><CategorySection data={currData} editMode={editMode} onChoreTab={openChore} onRefresh={refresh} onLogged={onLogged} /></div>}
              </div>
              <div className="overflow-y-auto" style={{ width: '33.333%' }}>
                {nextData && <div className="p-4"><CategorySection data={nextData} editMode={editMode} onChoreTab={openChore} onRefresh={refresh} onLogged={onLogged} /></div>}
              </div>
            </div>
          </div>
        )}

        {editMode && !showEmpty && (
          <div className="shrink-0 border-t border-slate-200 dark:border-slate-700/60 p-3">
            <button
              onClick={() => setAddingCategory(true)}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700/40 border border-slate-200 dark:border-slate-700/60 transition-colors"
            >
              <Plus size={15} />
              Add category
            </button>
          </div>
        )}
      </div>

      {/* ── Desktop: masonry columns ── */}
      <div className="hidden lg:block flex-1 overflow-y-auto">
        {showEmpty ? (
          <EmptyState onAdd={() => setAddingCategory(true)} />
        ) : (
          <div className="p-6">
            <div
              className="gap-5"
              style={{
                columns: data.length === 1 ? 1 : data.length === 2 ? 2 : data.length <= 4 ? 3 : 4,
                columnGap: '1.25rem',
              }}
            >
              {data.map(d => (
                <div key={d.category.id} className="break-inside-avoid mb-5">
                  <div className="bg-white dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700/50 rounded-2xl p-5">
                    <CategorySection
                      data={d}
                      editMode={editMode}
                      onChoreTab={openChore}
                      onRefresh={refresh}
                      onLogged={onLogged}
                    />
                  </div>
                </div>
              ))}
              {editMode && (
                <div className="break-inside-avoid mb-5">
                  <button
                    onClick={() => setAddingCategory(true)}
                    className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl text-sm text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700/30 border border-dashed border-slate-300 dark:border-slate-700/60 hover:border-slate-400 dark:hover:border-slate-600 transition-colors"
                  >
                    <Plus size={15} />
                    Add category
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {selectedChore && !editMode && (
        <LogModal
          chore={selectedChore}
          onClose={closeChore}
          onLogged={() => { closeChore(); afterLog() }}
        />
      )}

      {addingCategory && (
        <CategoryFormModal
          onClose={() => setAddingCategory(false)}
          onSaved={() => { setAddingCategory(false); refresh() }}
        />
      )}
    </>
  )
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8 text-center h-full min-h-[60vh]">
      <p className="text-slate-400 dark:text-slate-500 text-sm">No categories yet.</p>
      <button
        onClick={onAdd}
        className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-green-400 border border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60 transition-colors"
      >
        <Plus size={15} />
        Add your first category
      </button>
    </div>
  )
}
