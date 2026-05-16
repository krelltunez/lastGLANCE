import { useRef, useState } from 'react'
import { Download, Upload, X } from 'lucide-react'
import { exportBackup, importBackup, type BackupPayload } from '@/db/queries'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import dayjs from 'dayjs'

interface Props {
  onClose: () => void
  onImported: () => void
}

type State = 'idle' | 'exporting' | 'confirm' | 'importing' | 'error'

export function BackupModal({ onClose, onImported }: Props) {
  const [state, setState] = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [pending, setPending] = useState<BackupPayload | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEscapeKey(onClose)

  async function handleExport() {
    setState('exporting')
    try {
      const data = await exportBackup()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `lastglance-${dayjs().format('YYYY-MM-DD')}.json`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setState('idle')
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target?.result as string) as BackupPayload
        if (!Array.isArray(parsed.categories) || !Array.isArray(parsed.chores) || !Array.isArray(parsed.completionEvents)) {
          throw new Error('missing tables')
        }
        setPending(parsed)
        setState('confirm')
      } catch {
        setErrorMsg('Not a valid lastGLANCE backup file.')
        setState('error')
      }
    }
    reader.readAsText(file)
  }

  async function handleConfirm() {
    if (!pending) return
    setState('importing')
    try {
      await importBackup(pending)
      onImported()
      onClose()
    } catch {
      setErrorMsg('Import failed — the file may be corrupted.')
      setState('error')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-sm bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl border border-slate-200 dark:border-slate-700/50">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Backup & Restore</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {state === 'confirm' && pending ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-700 dark:text-slate-300">
              This will <strong>replace all current data</strong> with the backup.
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {pending.categories.length} categories · {pending.chores.length} chores · {pending.completionEvents.length} completion events
            </p>
            <div className="flex gap-3 pt-1">
              <button
                onClick={() => setState('idle')}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white bg-green-500 hover:bg-green-400 transition-colors"
              >
                Restore
              </button>
            </div>
          </div>
        ) : state === 'error' ? (
          <div className="space-y-4">
            <p className="text-sm text-red-500 dark:text-red-400">{errorMsg}</p>
            <button
              onClick={() => setState('idle')}
              className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
            >
              OK
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <button
              onClick={handleExport}
              disabled={state === 'exporting'}
              className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-slate-50 dark:bg-slate-700/50 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-600/40 transition-colors text-left disabled:opacity-50"
            >
              <Download size={16} className="text-green-400 shrink-0" />
              <div>
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  {state === 'exporting' ? 'Exporting…' : 'Export backup'}
                </p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">Download all data as JSON</p>
              </div>
            </button>

            <button
              onClick={() => fileRef.current?.click()}
              disabled={state === 'importing'}
              className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-slate-50 dark:bg-slate-700/50 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-600/40 transition-colors text-left disabled:opacity-50"
            >
              <Upload size={16} className="text-green-400 shrink-0" />
              <div>
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
                  {state === 'importing' ? 'Importing…' : 'Import backup'}
                </p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">Restore from a JSON file</p>
              </div>
            </button>

            <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={handleFileChange} />
          </div>
        )}
      </div>
    </div>
  )
}
