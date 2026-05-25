import { Clock, Bell, Leaf, Cloud, Loader } from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'

interface Props {
  onGetStarted: () => void
  onClearSample: () => Promise<void>
  clearing: boolean
}

const BULLETS = [
  { icon: Clock,  label: 'Cadence',   text: 'Set a target interval in days — overdue chores sort to the top automatically.' },
  { icon: Bell,   label: 'Reminders', text: 'Opt in to browser notifications when a chore is overdue.' },
  { icon: Leaf,   label: 'Seasonal',  text: 'Hide chores outside their active date range each year.' },
  { icon: Cloud,  label: 'Sync',      text: 'Keep everything in sync across devices via WebDAV or Nextcloud.' },
]

export function WelcomeModal({ onGetStarted, onClearSample, clearing }: Props) {
  useEscapeKey(onGetStarted)

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onGetStarted() }}
    >
      <div className="w-full sm:max-w-sm bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl border border-slate-200 dark:border-slate-700/50">
        <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200 mb-1">
          Welcome to lastGLANCE
        </h2>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-4 leading-relaxed">
          lastGLANCE helps you track when you last did something, and optionally surface when you need to do it again.
        </p>

        <ul className="space-y-3 mb-5">
          {BULLETS.map(({ icon: Icon, label, text }) => (
            <li key={label} className="flex items-start gap-3">
              <Icon size={14} className="text-green-400 shrink-0 mt-0.5" />
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                <span className="font-semibold text-slate-700 dark:text-slate-200">{label} — </span>
                {text}
              </p>
            </li>
          ))}
        </ul>

        <div className="flex gap-3">
          <button
            onClick={onClearSample}
            disabled={clearing}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            {clearing ? <><Loader size={13} className="animate-spin" />Clearing…</> : 'Clear sample data'}
          </button>
          <button
            onClick={onGetStarted}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white bg-green-500 hover:bg-green-400 transition-colors"
          >
            Get Started
          </button>
        </div>
      </div>
    </div>
  )
}
