import { Ribbon } from '@/components/Ribbon/Ribbon'

export default function App() {
  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <header className="shrink-0 px-4 py-3 border-b border-slate-700/60 flex items-center justify-between">
        <h1 className="text-sm font-semibold tracking-tight text-slate-100">
          last<span className="font-black text-green-400">GLANCE</span>
        </h1>
        {/* Future: settings / add category button */}
      </header>

      <main className="flex-1 flex flex-col overflow-hidden">
        <Ribbon />
      </main>
    </div>
  )
}
