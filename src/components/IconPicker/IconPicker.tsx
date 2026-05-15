import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { ICON_REGISTRY, ICON_NAMES, ICON_GROUPS } from '@/icons/registry'
import { useEscapeKey } from '@/hooks/useEscapeKey'

interface Props {
  selected?: string
  onSelect: (iconName: string | undefined) => void
  onClose: () => void
}

export function IconPicker({ selected, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('')
  useEscapeKey(onClose)

  const q = query.trim().toLowerCase()
  const isSearching = q.length > 0
  const filteredFlat = isSearching
    ? ICON_NAMES.filter(n => n.toLowerCase().includes(q))
    : []

  function pick(name: string) {
    onSelect(name)
    onClose()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/40 dark:bg-black/70 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/50 rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[85svh]">

        {/* Search bar */}
        <div className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-slate-100 dark:border-slate-700/60 shrink-0">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search icons…"
            autoFocus
            className="flex-1 bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
          />
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {/* Current selection */}
        {selected && (
          <div className="px-4 py-2 border-b border-slate-100 dark:border-slate-700/40 shrink-0 flex items-center gap-2">
            <span className="text-xs text-slate-400 dark:text-slate-500">Selected:</span>
            {(() => { const Icon = ICON_REGISTRY[selected]; return Icon ? <Icon size={15} className="text-green-400" /> : null })()}
            <span className="text-xs text-slate-600 dark:text-slate-300">{selected}</span>
            <button
              onClick={() => { onSelect(undefined); onClose() }}
              className="ml-auto text-xs text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 transition-colors"
            >
              Remove
            </button>
          </div>
        )}

        {/* Icon grid */}
        <div className="overflow-y-auto">
          {isSearching ? (
            // Flat search results
            <div className="p-3">
              {filteredFlat.length === 0 ? (
                <p className="text-sm text-slate-400 dark:text-slate-500 text-center py-8">
                  No icons match "{query}"
                </p>
              ) : (
                <>
                  <p className="text-xs text-slate-400 dark:text-slate-500 mb-2 px-1">
                    {filteredFlat.length} result{filteredFlat.length !== 1 ? 's' : ''}
                  </p>
                  <IconGrid names={filteredFlat} selected={selected} onPick={pick} />
                </>
              )}
            </div>
          ) : (
            // Categorized view
            <div className="p-3 space-y-5">
              {ICON_GROUPS.map(group => (
                <div key={group.label}>
                  <p className="text-xs font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider mb-2 px-1">
                    {group.label}
                  </p>
                  <IconGrid names={group.icons} selected={selected} onPick={pick} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}

function IconGrid({ names, selected, onPick }: {
  names: string[]
  selected: string | undefined
  onPick: (name: string) => void
}) {
  return (
    <div className="grid grid-cols-8 sm:grid-cols-10 gap-1">
      {names.map(name => {
        const Icon = ICON_REGISTRY[name]
        if (!Icon) return null
        const isSelected = name === selected
        return (
          <button
            key={name}
            title={name}
            onClick={() => onPick(name)}
            className={`
              flex items-center justify-center w-full aspect-square rounded-lg transition-colors
              ${isSelected
                ? 'bg-green-400/20 text-green-500 dark:text-green-400 ring-1 ring-green-400/50'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-700'}
            `}
          >
            <Icon size={18} />
          </button>
        )
      })}
    </div>
  )
}
