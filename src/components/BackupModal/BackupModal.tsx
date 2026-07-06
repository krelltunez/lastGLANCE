import { useRef, useState, useEffect } from 'react'
import { Download, Upload, Cloud, X, Loader, Trash2 } from 'lucide-react'
import { exportBackup, restoreFromBackup, hasSeedData, seedChoresUsed, clearSeedData, type BackupPayload } from '@/db/queries'
import { buildPayload } from '@/sync/engine'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import type { SyncEngine } from '@glance-apps/sync'
import dayjs from 'dayjs'
import { useTranslation } from 'react-i18next'

interface Props {
  engine: SyncEngine | null
  onClose: () => void
  onImported: () => void
}

type RemoteFile = { filename: string; lastModified: string | null }
type State = 'idle' | 'exporting' | 'confirm' | 'sure' | 'importing' | 'remote-list' | 'remote-loading' | 'remote-confirm' | 'error'

export function BackupModal({ engine, onClose, onImported }: Props) {
  const { t } = useTranslation()
  const [state, setState] = useState<State>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [pending, setPending] = useState<BackupPayload | null>(null)
  // The raw payload queued for the final "Are you sure?" gate — either the parsed
  // file (pending) or a downloaded remote backup (remotePending). restoreFromBackup
  // accepts both on-disk shapes, so we can hand it either verbatim.
  const [pendingRaw, setPendingRaw] = useState<unknown>(null)
  const [remoteFiles, setRemoteFiles] = useState<RemoteFile[]>([])
  const [selectedRemote, setSelectedRemote] = useState<RemoteFile | null>(null)
  const [remotePending, setRemotePending] = useState<unknown>(null)
  const [showClearSample, setShowClearSample] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (localStorage.getItem('lg-seed-cleared')) return
    hasSeedData().then(has => {
      if (!has) return
      seedChoresUsed().then(used => {
        if (used) { localStorage.setItem('lg-seed-cleared', '1'); return }
        setShowClearSample(true)
      })
    })
  }, [])

  const syncConfig = engine?.getConfig() ?? null
  const hasRemote = Boolean(syncConfig?.enabled && syncConfig?.webdavUrl)

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
        setErrorMsg(t('backup.invalidFile'))
        setState('error')
      }
    }
    reader.readAsText(file)
  }

  // Save a parachute of the CURRENT data before a destructive restore: a local
  // file download (works everywhere) plus, if a remote is configured, a fresh
  // snapshot in the WebDAV backups/ folder. Best-effort — a snapshot failure
  // must not block the user from restoring.
  async function saveSafetySnapshot() {
    try {
      const data = await exportBackup()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `lastglance-before-restore-${dayjs().format('YYYY-MM-DD-HHmm')}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch { /* best-effort local parachute */ }
    if (engine && syncConfig) {
      try {
        const provider = engine.autoBackupProviders[syncConfig.provider as string] ?? engine.autoBackupProviders.webdav
        await provider.uploadBackup(syncConfig as Record<string, unknown>, await buildPayload())
      } catch { /* best-effort remote parachute */ }
    }
  }

  // Final step after the "Are you sure?" gate: snapshot, then replace all data
  // with the queued backup. restoreFromBackup re-stamps and tombstones so the
  // restore wins the sync merge; kicking engine.sync() uploads it promptly.
  async function performRestore() {
    if (pendingRaw == null) return
    setState('importing')
    try {
      await saveSafetySnapshot()
      await restoreFromBackup(pendingRaw)
      onImported()
      engine?.sync().catch(() => { /* surfaced via onError */ })
      onClose()
    } catch (err) {
      const empty = err instanceof Error && err.message === 'empty backup'
      setErrorMsg(empty ? t('backup.emptyBackup') : t('backup.restoreFailed'))
      setState('error')
    }
  }

  async function handleListRemote() {
    if (!engine || !syncConfig) return
    setState('remote-list')
    try {
      const provider = engine.autoBackupProviders[syncConfig.provider as string] ?? engine.autoBackupProviders.webdav
      const files = await provider.listBackups(syncConfig as Record<string, unknown>)
      setRemoteFiles(files)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('backup.remoteListFailed'))
      setState('error')
    }
  }

  async function handleSelectRemote(file: RemoteFile) {
    if (!engine || !syncConfig) return
    setSelectedRemote(file)
    setState('remote-loading')
    try {
      const provider = engine.autoBackupProviders[syncConfig.provider as string] ?? engine.autoBackupProviders.webdav
      const data = await provider.downloadBackup(syncConfig as Record<string, unknown>, file.filename)
      setRemotePending(data)
      setState('remote-confirm')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : t('backup.remoteDownloadFailed'))
      setState('error')
    }
  }

  function formatDate(iso: string | null) {
    if (!iso) return t('backup.unknownDate')
    return dayjs(iso).format('MMM D, YYYY h:mm A')
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center app-safe-bottom bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-sm bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl border border-slate-200 dark:border-slate-700/50">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">{t('backup.title')}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {state === 'confirm' && pending ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-700 dark:text-slate-300"
               dangerouslySetInnerHTML={{ __html: t('backup.replaceWarning') }} />
            <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {t('backup.summary', {
                categories: pending.categories.length,
                chores: pending.chores.length,
                events: pending.completionEvents.length,
              })}
            </p>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setState('idle')} className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                {t('backup.cancel')}
              </button>
              <button onClick={() => { setPendingRaw(pending); setState('sure') }} className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white bg-green-500 hover:bg-green-400 transition-colors">
                {t('backup.restore')}
              </button>
            </div>
          </div>

        ) : state === 'sure' ? (
          <div className="space-y-4">
            <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('backup.areYouSure')}</p>
            <p className="text-sm text-slate-600 dark:text-slate-300">{t('backup.areYouSureBody')}</p>
            <p className="text-xs text-slate-500 dark:text-slate-400 flex items-start gap-1.5">
              <Download size={13} className="text-green-400 shrink-0 mt-0.5" />
              {t('backup.snapshotNote')}
            </p>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setState('idle')} className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                {t('backup.cancel')}
              </button>
              <button onClick={performRestore} className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white bg-red-500 hover:bg-red-400 transition-colors">
                {t('backup.replaceEverything')}
              </button>
            </div>
          </div>

        ) : state === 'remote-list' ? (
          <div className="space-y-3">
            <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">{t('backup.remoteBackups')}</p>
            {remoteFiles.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">{t('backup.noRemoteBackups')}</p>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto">
                {remoteFiles.map(f => (
                  <button
                    key={f.filename}
                    onClick={() => handleSelectRemote(f)}
                    className="w-full text-left px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-700/50 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-600/40 transition-colors"
                  >
                    <p className="text-xs font-medium text-slate-700 dark:text-slate-200">{formatDate(f.lastModified)}</p>
                    <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5 truncate">{f.filename}</p>
                  </button>
                ))}
              </div>
            )}
            <button onClick={() => setState('idle')} className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
              {t('backup.cancel')}
            </button>
          </div>

        ) : state === 'remote-loading' ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-slate-500 dark:text-slate-400">
            <Loader size={14} className="animate-spin" />
            {t('backup.downloading')}
          </div>

        ) : state === 'remote-confirm' && selectedRemote ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-700 dark:text-slate-300"
               dangerouslySetInnerHTML={{ __html: t('backup.replaceRemoteWarning') }} />
            <p className="text-xs text-slate-500 dark:text-slate-400">{formatDate(selectedRemote.lastModified)}</p>
            <div className="flex gap-3 pt-1">
              <button onClick={() => setState('idle')} className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
                {t('backup.cancel')}
              </button>
              <button onClick={() => { setPendingRaw(remotePending); setState('sure') }} className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white bg-green-500 hover:bg-green-400 transition-colors">
                {t('backup.restore')}
              </button>
            </div>
          </div>

        ) : state === 'importing' ? (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-slate-500 dark:text-slate-400">
            <Loader size={14} className="animate-spin" />
            {t('backup.restoring')}
          </div>

        ) : state === 'error' ? (
          <div className="space-y-4">
            <p className="text-sm text-red-500 dark:text-red-400">{errorMsg}</p>
            <button onClick={() => setState('idle')} className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
              {t('backup.ok')}
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
                  {state === 'exporting' ? t('backup.exporting') : t('backup.exportTitle')}
                </p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{t('backup.exportDesc')}</p>
              </div>
            </button>

            <button
              onClick={() => fileRef.current?.click()}
              className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-slate-50 dark:bg-slate-700/50 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-600/40 transition-colors text-left"
            >
              <Upload size={16} className="text-green-400 shrink-0" />
              <div>
                <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{t('backup.importTitle')}</p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{t('backup.importDesc')}</p>
              </div>
            </button>

            {hasRemote && (
              <button
                onClick={handleListRemote}
                className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-slate-50 dark:bg-slate-700/50 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-600/40 transition-colors text-left"
              >
                <Cloud size={16} className="text-green-400 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{t('backup.remoteRestoreTitle')}</p>
                  <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{t('backup.remoteRestoreDesc')}</p>
                </div>
              </button>
            )}

            {showClearSample && (
              <button
                onClick={async () => {
                  setState('importing')
                  try {
                    await clearSeedData()
                    localStorage.setItem('lg-seed-cleared', '1')
                    setShowClearSample(false)
                    onImported()
                    onClose()
                  } catch {
                    setErrorMsg(t('backup.clearFailed'))
                    setState('error')
                  }
                }}
                className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl bg-slate-50 dark:bg-slate-700/50 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-600/40 transition-colors text-left"
              >
                <Trash2 size={16} className="text-slate-400 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-slate-700 dark:text-slate-200">{t('backup.clearSampleTitle')}</p>
                  <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{t('backup.clearSampleDesc')}</p>
                </div>
              </button>
            )}

            <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={handleFileChange} />
          </div>
        )}
      </div>
    </div>
  )
}
