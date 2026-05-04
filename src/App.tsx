import { useState } from 'react'
import { Pencil, Check } from 'lucide-react'
import { Ribbon } from '@/components/Ribbon/Ribbon'

export default function App() {
  const [editMode, setEditMode] = useState(false)

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <header className="shrink-0 px-4 py-3 border-b border-slate-700/60 flex items-center justify-between">
        <h1 className="text-sm font-semibold tracking-tight text-slate-100">
          last<span className="font-black text-green-400">GLANCE</span>
        </h1>
        <button
          onClick={() => setEditMode(e => !e)}
          className={`
            flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors
            ${editMode
              ? 'bg-green-400 text-slate-900 hover:bg-green-300'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-700/60'}
          `}
          aria-label={editMode ? 'Done editing' : 'Edit categories and chores'}
        >
          {editMode ? <><Check size={13} /> Done</> : <><Pencil size={13} /> Edit</>}
        </button>
      </header>

      <main className="flex-1 flex flex-col overflow-hidden">
        <Ribbon editMode={editMode} />
      </main>
    </div>
  )
}
