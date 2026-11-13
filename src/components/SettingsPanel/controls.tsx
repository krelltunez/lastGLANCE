import type { ReactNode } from 'react'

// The Settings panel's form controls, shared by its sections and by the panels
// it mounts (src/components/LocalIntegrations/).

export function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  const cls = 'block mb-1.5 text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500'
  return (
    <div>
      {htmlFor
        ? <label htmlFor={htmlFor} className={cls}>{label}</label>
        : <div className={cls}>{label}</div>}
      {children}
    </div>
  )
}

export function Description({ children }: { children: ReactNode }) {
  return <p className="text-sm text-slate-500 dark:text-slate-400">{children}</p>
}

export function Segmented<T extends string>({ label, value, onChange, options }: {
  label: string
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string; icon?: ReactNode }[]
}) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg border border-slate-200 dark:border-slate-700 p-0.5 gap-0.5">
      {options.map(o => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className={`flex-1 min-w-0 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors ${
              selected
                ? 'bg-green-400/15 text-green-500 dark:text-green-400 font-medium'
                : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700'
            }`}
          >
            {o.icon}
            <span className="truncate">{o.label}</span>
          </button>
        )
      })}
    </div>
  )
}
