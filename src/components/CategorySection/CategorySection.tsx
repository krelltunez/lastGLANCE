import type { CategoryWithChores } from '@/hooks/useChores'
import type { ChoreWithLastCompletion } from '@/types'
import { ChoreRow } from '@/components/ChoreRow/ChoreRow'

interface Props {
  data: CategoryWithChores
  onChoreTab: (chore: ChoreWithLastCompletion) => void
}

export function CategorySection({ data, onChoreTab }: Props) {
  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-slate-700/60">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">
          {data.category.name}
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto divide-y divide-slate-700/40">
        {data.chores.length === 0 ? (
          <p className="px-4 py-6 text-sm text-slate-500 text-center">
            No chores yet — add one to get started.
          </p>
        ) : (
          data.chores.map(chore => (
            <ChoreRow
              key={chore.id}
              chore={chore}
              onTap={onChoreTab}
            />
          ))
        )}
      </div>
    </div>
  )
}
