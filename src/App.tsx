import { useDBReady } from '@/hooks/useDB'
import { Ribbon } from '@/components/Ribbon/Ribbon'

export default function App() {
  const { state, error } = useDBReady()

  if (state === 'loading') {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center">
        <div className="text-slate-400 text-sm">Initializing database…</div>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="min-h-screen bg-surface flex items-center justify-center p-8">
        <div className="text-center space-y-2">
          <p className="text-red-400 text-sm font-medium">Failed to initialize storage</p>
          <p className="text-slate-500 text-xs">{error?.message}</p>
        </div>
      </div>
    )
  }

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
