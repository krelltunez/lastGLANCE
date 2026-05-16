import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Bell, Check, Loader } from 'lucide-react'

export interface ToastOptions {
  title: string
  body?: string
  type?: 'default' | 'success' | 'warning'
  duration?: number
  onAction?: () => Promise<void> | void
}

interface ToastItem extends ToastOptions {
  id: string
}

interface ToastContextValue {
  showToast: (opts: ToastOptions) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}

const MAX_TOASTS = 4

function DoneButton({ onAction, onExit }: { onAction?: () => Promise<void> | void; onExit: () => void }) {
  const [saving, setSaving] = useState(false)

  async function handle() {
    if (saving) return
    setSaving(true)
    try { await onAction?.() } finally { onExit() }
  }

  return (
    <button
      onClick={handle}
      disabled={saving}
      className="mt-2 flex items-center gap-1 text-xs font-medium text-amber-500 dark:text-amber-400 hover:text-amber-600 dark:hover:text-amber-300 disabled:opacity-50 transition-colors"
    >
      {saving ? <Loader size={11} className="animate-spin" /> : <Check size={11} strokeWidth={2.5} />}
      Done
    </button>
  )
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: () => void }) {
  const duration = toast.type === 'warning' ? null : (toast.duration ?? 4000)
  const [exiting, setExiting] = useState(false)

  const exit = useCallback(() => {
    setExiting(true)
    setTimeout(onDismiss, 250)
  }, [onDismiss])

  useEffect(() => {
    if (duration === null) return
    const t = setTimeout(exit, duration)
    return () => clearTimeout(t)
  }, [duration, exit])

  const Icon = toast.type === 'success' ? Check : Bell
  const iconColor =
    toast.type === 'success' ? 'text-green-400' :
    toast.type === 'warning' ? 'text-amber-400' :
    'text-slate-400'

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 rounded-xl shadow-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700/80 w-72 transition-all duration-200 ${
        exiting ? 'opacity-0 translate-x-3' : 'opacity-100 translate-x-0'
      }`}
    >
      <div className={`shrink-0 mt-0.5 ${iconColor}`}>
        <Icon size={15} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-slate-800 dark:text-slate-100 leading-snug truncate">
          {toast.title}
        </p>
        {toast.body && (
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{toast.body}</p>
        )}
        {toast.type === 'warning' && (
          <DoneButton onAction={toast.onAction} onExit={exit} />
        )}
      </div>
      <button
        onClick={exit}
        className="shrink-0 mt-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
        aria-label="Dismiss"
      >
        <X size={13} />
      </button>
    </div>
  )
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const showToast = useCallback((opts: ToastOptions) => {
    setToasts(prev => {
      const next = [...prev, { ...opts, id: crypto.randomUUID() }]
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next
    })
  }, [])

  useEffect(() => {
    (window as unknown as Record<string, unknown>).__toast = showToast
    return () => { delete (window as unknown as Record<string, unknown>).__toast }
  }, [showToast])

  function dismiss(id: string) {
    setToasts(prev => prev.filter(t => t.id !== id))
  }

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {createPortal(
        <div className="fixed z-[60] flex flex-col gap-2 items-end bottom-20 right-4 min-[1060px]:bottom-6 min-[1060px]:right-6">
          {toasts.map(toast => (
            <ToastCard key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
          ))}
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  )
}
