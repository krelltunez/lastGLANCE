import { useState } from 'react'
import { useChores } from '@/hooks/useChores'
import { CategorySection } from '@/components/CategorySection/CategorySection'
import { LogModal } from '@/components/LogModal/LogModal'
import type { ChoreWithLastCompletion } from '@/types'

export function Ribbon() {
  const { data, loading, refresh } = useChores()
  const [activeCategoryIndex, setActiveCategoryIndex] = useState(0)
  const [selectedChore, setSelectedChore] = useState<ChoreWithLastCompletion | null>(null)

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-slate-500 text-sm">Loading…</div>
      </div>
    )
  }

  if (data.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-8 text-center">
        <div>
          <p className="text-slate-400 text-sm">No categories yet.</p>
          <p className="text-slate-500 text-xs mt-1">Add a category to get started.</p>
        </div>
      </div>
    )
  }

  return (
    <>
      {/* Mobile: one category at a time with tab strip */}
      <div className="flex flex-col flex-1 overflow-hidden lg:hidden">
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

        <div className="flex-1 overflow-hidden">
          {data[activeCategoryIndex] && (
            <CategorySection
              data={data[activeCategoryIndex]}
              onChoreTab={setSelectedChore}
            />
          )}
        </div>
      </div>

      {/* Desktop: multiple categories side by side */}
      <div className="hidden lg:flex flex-1 overflow-hidden divide-x divide-slate-700/60">
        {data.map(d => (
          <div key={d.category.id} className="flex-1 min-w-0 overflow-hidden">
            <CategorySection data={d} onChoreTab={setSelectedChore} />
          </div>
        ))}
      </div>

      {selectedChore && (
        <LogModal
          chore={selectedChore}
          onClose={() => setSelectedChore(null)}
          onLogged={() => {
            setSelectedChore(null)
            refresh()
          }}
        />
      )}
    </>
  )
}
