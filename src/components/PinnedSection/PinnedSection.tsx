import { Pin } from 'lucide-react'
import type { ChoreWithLastCompletion } from '@/types'
import type { PinnedChore } from '@/utils/pinned'
import { ChoreRow } from '@/components/ChoreRow/ChoreRow'
import { useTranslation } from 'react-i18next'

interface Props {
  pinned: PinnedChore[]
  // 'page': the narrow layout's first tab, laid out like a category page.
  // 'row':  the wide layout's full-width row above the masonry.
  // Both wrap onto further lines rather than scrolling, so every pin stays in view.
  variant: 'page' | 'row'
  onChoreTab: (chore: ChoreWithLastCompletion) => void
  onRefresh: () => void
  onLogged?: () => void
}

const noop = () => {}

// Narrowest a tile gets. It has to hold the name with its badges plus both
// buttons (Done, and → dG when the chore is overdue and dayGLANCE is set up)
// without truncating the name to a few letters. min() lets a single column
// shrink to a phone's width.
//
// Every row of the grid is 1fr, so all tiles take the height of the tallest:
// two rows of text when every subtitle fits on one line, three as soon as any
// one wraps.
const GRID_STYLE = {
  gridTemplateColumns: 'repeat(auto-fill, minmax(min(380px, 100%), 1fr))',
  gridAutoRows: '1fr',
}

// Never shown in edit mode (pins are rearranged by urgency, not by hand, and
// each chore is edited in its own category), so the rows here are always the
// read-only kind and the edit/delete callbacks are never reached.
export function PinnedSection({ pinned, variant, onChoreTab, onRefresh, onLogged }: Props) {
  const { t } = useTranslation()
  const page = variant === 'page'

  return (
    <section className="flex flex-col" aria-label={t('ribbon.pinned')}>
      <div className="flex items-center gap-2.5 mb-3">
        <Pin size={page ? 18 : 16} className="text-green-400 shrink-0" />
        <h2 className="text-base font-bold text-green-400 tracking-tight truncate">{t('ribbon.pinned')}</h2>
      </div>
      <div className="grid gap-2" style={GRID_STYLE}>
        {pinned.map(({ chore, categoryName }) => (
          <div key={chore.id} className="min-w-0">
            <ChoreRow
              chore={chore}
              categoryName={categoryName}
              editMode={false}
              onTap={onChoreTab}
              onEdit={noop}
              onDelete={noop}
              onRefresh={() => { onRefresh(); onLogged?.() }}
            />
          </div>
        ))}
      </div>
    </section>
  )
}
