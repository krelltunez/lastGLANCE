import { useState } from 'react'
import { Plus } from 'lucide-react'
import { useChores } from '@/hooks/useChores'
import { CategorySection } from '@/components/CategorySection/CategorySection'
import { LogModal } from '@/components/LogModal/LogModal'
import { HistoryView } from '@/components/HistoryView/HistoryView'
import { CategoryFormModal } from '@/components/CategoryFormModal/CategoryFormModal'
import type { ChoreWithLastCompletion } from '@/types'

interface Props {
  editMode: boolean
}

export function Ribbon({ editMode }: Props) {
  const { data, loading, refresh } = useChores()
  const [activeCategoryIndex, setActiveCategoryIndex] = useState(0)
  const [selectedChore, setSelectedChore] = useState<ChoreWithLastCompletion | null>(null)
  const [view, setView] = useState<'log' | 'history'>('log')
  const [addingCategory, setAddingCategory] = useState(false)

  function openChore(chore: ChoreWithLastCompletion) {
    setSelectedChore(chore)
    setView('log')
  }

  function closeChore() {
    setSelectedChore(null)
    setView('log')
  }

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-slate-500 text-sm">Loading…</div>
      </div>
    )
  }

  const showEmpty = data.length === 0

  return (
    <>
      {/* Mobile: one category at a time with tab strip */}
      <div className="flex flex-col flex-1 overflow-hidden lg:hidden">
        {!showEmpty && (
          <div className="flex overflow-x-auto scrollbar-none border-b border-slate-700/60 bg-slate-900">
            {data.map((d, i) => (
              <button
                key={d.category.id}
                onClick={() => setActiveCategoryIndex(i)}
                className={`
                  shrink-0 px-4 py-2.5 text-xs font-medium transition-colors whitespace-nowrap
                  ${i === activeCategoryIndex
                    ? 'text-white border-b-2 border-green-400'
                    : 'text-slate-400 hover:text-slate-200'}
                `}
              >
                {d.category.name}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-hidden">
          {showEmpty ? (
            <EmptyState onAdd={() => setAddingCategory(true)} />
          ) : (
            data[activeCategoryIndex] && (
              <CategorySection
                data={data[activeCategoryIndex]}
                editMode={editMode}
                onChoreTab={openChore}
                onRefresh={refresh}
              />
            )
          )}
        </div>

        {editMode && !showEmpty && (
          <div className="shrink-0 border-t border-slate-700/60 p-3">
            <button
              onClick={() => setAddingCategory(true)}
              className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-700/40 border border-slate-700/60 transition-colors"
            >
              <Plus size={15} />
              Add category
            </button>
          </div>
        )}
      </div>

      {/* Desktop: multiple categories side by side */}
      <div className="hidden lg:flex flex-1 overflow-hidden divide-x divide-slate-700/60">
        {showEmpty ? (
          <div className="flex-1">
            <EmptyState onAdd={() => setAddingCategory(true)} />
          </div>
        ) : (
          <>
            {data.map(d => (
              <div key={d.category.id} className="flex-1 min-w-0 overflow-hidden flex flex-col">
                <CategorySection
                  data={d}
                  editMode={editMode}
                  onChoreTab={openChore}
                  onRefresh={refresh}
                />
              </div>
            ))}
            {editMode && (
              <div className="w-48 flex flex-col items-center justify-start pt-12 px-4">
                <button
                  onClick={() => setAddingCategory(true)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm text-slate-400 hover:text-slate-200 hover:bg-slate-700/40 border border-slate-700/60 transition-colors"
                >
                  <Plus size={15} />
                  Add category
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {selectedChore && !editMode && view === 'log' && (
        <LogModal
          chore={selectedChore}
          onClose={closeChore}
          onLogged={() => { closeChore(); refresh() }}
          onViewHistory={() => setView('history')}
        />
      )}

      {selectedChore && !editMode && view === 'history' && (
        <HistoryView
          chore={selectedChore}
          onBack={() => setView('log')}
          onClose={closeChore}
          onChanged={refresh}
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
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-8 text-center h-full">
      <p className="text-slate-400 text-sm">No categories yet.</p>
      <button
        onClick={onAdd}
        className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium text-slate-900 bg-green-400 hover:bg-green-300 transition-colors"
      >
        <Plus size={15} />
        Add your first category
      </button>
    </div>
  )
}
