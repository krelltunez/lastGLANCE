import { useState } from 'react'
import { X } from 'lucide-react'
import { ICON_REGISTRY, ICON_NAMES } from '@/icons/registry'
import { useEscapeKey } from '@/hooks/useEscapeKey'

interface Props {
  selected?: string
  onSelect: (iconName: string | undefined) => void
  onClose: () => void
}

export function IconPicker({ selected, onSelect, onClose }: Props) {
  const [query, setQuery] = useState('')
  useEscapeKey(onClose)

  const filtered = query.trim()
    ? ICON_NAMES.filter(n => n.toLowerCase().includes(query.toLowerCase()))
    : ICON_NAMES

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-lg bg-slate-800 border border-slate-700/50 rounded-t-2xl sm:rounded-2xl shadow-2xl flex flex-col max-h-[80svh]">
        <div className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-slate-700/60 shrink-0">
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search icons…"
            autoFocus
            className="flex-1 bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 border border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
          />
          <button onClick={onClose} className="text-slate-400 hover:text-slate-200 transition-colors shrink-0">
            <X size={18} />
          </button>
        </div>

        {selected && (
          <div className="px-4 py-2 border-b border-slate-700/40 shrink-0 flex items-center gap-2">
            <span className="text-xs text-slate-500">Current:</span>
            {(() => { const Icon = ICON_REGISTRY[selected]; return Icon ? <Icon size={16} className="text-green-400" /> : null })()}
            <span className="text-xs text-slate-300">{selected}</span>
            <button
              onClick={() => { onSelect(undefined); onClose() }}
              className="ml-auto text-xs text-slate-500 hover:text-red-400 transition-colors"
            >
              Remove icon
            </button>
          </div>
        )}

        <div className="overflow-y-auto p-3">
          {filtered.length === 0 ? (
            <p className="text-sm text-slate-500 text-center py-8">No icons match "{query}"</p>
          ) : (
            <div className="grid grid-cols-8 sm:grid-cols-10 gap-1.5">
              {filtered.map(name => {
                const Icon = ICON_REGISTRY[name]
                if (!Icon) return null
                const isSelected = name === selected
                return (
                  <button
                    key={name}
                    title={name}
                    onClick={() => { onSelect(name); onClose() }}
                    className={`
                      flex items-center justify-center w-full aspect-square rounded-lg transition-colors
                      ${isSelected
                        ? 'bg-green-400 text-slate-900'
                        : 'text-slate-400 hover:text-slate-100 hover:bg-slate-700'}
                    `}
                  >
                    <Icon size={18} />
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
