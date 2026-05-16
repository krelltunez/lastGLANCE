import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Search, X } from 'lucide-react'
import type { ChoreWithLastCompletion, Category } from '@/types'
import type { CategoryWithChores } from '@/hooks/useChores'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { ICON_REGISTRY } from '@/icons/registry'

interface SearchResult {
  chore: ChoreWithLastCompletion
  category: Category
}

interface Props {
  data: CategoryWithChores[]
  onSelect: (chore: ChoreWithLastCompletion) => void
  onClose: () => void
}

function highlight(text: string, query: string) {
  if (!query) return <>{text}</>
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-green-400/30 text-inherit rounded-sm">{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  )
}

export function SearchModal({ data, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  useEscapeKey(onClose)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const q = query.trim().toLowerCase()

  const results: SearchResult[] = q === ''
    ? []
    : data.flatMap(({ category, chores, subcategories }) => [
        ...chores
          .filter(c => c.name.toLowerCase().includes(q))
          .map(chore => ({ chore, category })),
        ...subcategories.flatMap(({ category: subCat, chores: subChores }) =>
          subChores
            .filter(c => c.name.toLowerCase().includes(q))
            .map(chore => ({ chore, category: subCat }))
        ),
      ]).sort((a, b) => {
        const aPrefix = a.chore.name.toLowerCase().startsWith(q)
        const bPrefix = b.chore.name.toLowerCase().startsWith(q)
        if (aPrefix && !bPrefix) return -1
        if (!aPrefix && bPrefix) return 1
        return a.chore.name.localeCompare(b.chore.name)
      })

  useEffect(() => { setActiveIdx(0) }, [q])

  // Scroll active item into view
  useEffect(() => {
    const el = listRef.current?.children[activeIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && results.length > 0) {
      e.preventDefault()
      onSelect(results[activeIdx].chore)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[12vh] px-4 bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-white dark:bg-slate-800 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/50 overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Input row */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-slate-100 dark:border-slate-700/60">
          <Search size={15} className="text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search chores…"
            className="flex-1 bg-transparent text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none"
          />
          {query ? (
            <button
              onClick={() => setQuery('')}
              className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          ) : (
            <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono text-slate-400 dark:text-slate-500 bg-slate-100 dark:bg-slate-700/60 border border-slate-200 dark:border-slate-600">
              esc
            </kbd>
          )}
        </div>

        {/* Results */}
        {q !== '' && (
          <div className="max-h-72 overflow-y-auto">
            {results.length === 0 ? (
              <p className="text-center text-sm text-slate-400 dark:text-slate-500 py-8">No chores match</p>
            ) : (
              <ul ref={listRef}>
                {results.map(({ chore, category }, idx) => {
                  const Icon = chore.icon ? ICON_REGISTRY[chore.icon] : null
                  return (
                    <li key={chore.id}>
                      <button
                        className={`w-full text-left px-4 py-3 flex items-center gap-3 text-sm transition-colors ${
                          idx === activeIdx
                            ? 'bg-slate-50 dark:bg-slate-700/60'
                            : 'hover:bg-slate-50 dark:hover:bg-slate-700/40'
                        }`}
                        onClick={() => onSelect(chore)}
                        onMouseEnter={() => setActiveIdx(idx)}
                      >
                        {Icon && <Icon size={14} className="shrink-0 text-slate-400" />}
                        <span className="font-medium text-slate-900 dark:text-slate-100 flex-1 min-w-0 truncate">
                          {highlight(chore.name, q)}
                        </span>
                        <span className="text-xs text-slate-400 dark:text-slate-500 shrink-0">
                          {category.name}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}

        {/* Empty prompt */}
        {q === '' && (
          <p className="text-center text-xs text-slate-400 dark:text-slate-500 py-6">
            Start typing to search chores
          </p>
        )}
      </div>
    </div>,
    document.body
  )
}
