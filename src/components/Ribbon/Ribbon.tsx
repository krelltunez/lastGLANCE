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

export function Ribbon({ editMode, onLogged }: Props) {
  const { data, loading, refresh } = useChores()
  const [activeCategoryIndex, setActiveCategoryIndex] = useState(0)
  const [selectedChore, setSelectedChore] = useState<ChoreWithLastCompletion | null>(null)
  const [addingCategory, setAddingCategory] = useState(false)
  const touchStartX = useRef(0)
  const touchStartY = useRef(0)
  const tabsRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = tabsRef.current?.children[activeCategoryIndex] as HTMLElement | undefined
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
  }, [activeCategoryIndex])

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
  }

  function handleTouchEnd(e: React.TouchEvent) {
    const dx = e.changedTouches[0].clientX - touchStartX.current
    const dy = e.changedTouches[0].clientY - touchStartY.current
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy)) return
    setActiveCategoryIndex(i =>
      dx < 0 ? Math.min(i + 1, data.length - 1) : Math.max(i - 1, 0)
    )
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

        <div
          className="flex-1 overflow-y-auto"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          {showEmpty ? (
            <EmptyState onAdd={() => setAddingCategory(true)} />
          ) : (
            data[activeCategoryIndex] && (
              <div className="p-4">
                <CategorySection
                  data={data[activeCategoryIndex]}
                  editMode={editMode}
                  onChoreTab={openChore}
                  onRefresh={refresh}
                  onLogged={onLogged}
                />
              </div>
            )
          )}
        </div>

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
