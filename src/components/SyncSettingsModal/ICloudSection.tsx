import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle, Loader, XCircle } from 'lucide-react'
import { icloudTransport, ICLOUD_LAST_SYNCED_KEY, type ICloudTransport } from '@/sync/icloud'
import { formatDateTime } from '@/utils/datetime'

// The iCloud section of the Cloud Sync dialog (docs/icloud-sync.md), iOS only.
// iCloud sync is on by default with nothing to set up; this is its per-device
// switch (the same preference the first-run question records, so "start fresh"
// can be undone here), "Sync now" and the last-synced stamp. Off is inert, not
// destructive: the iCloud copy stays and other devices keep syncing.

const button = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 transition-colors'

interface Props {
  transport?: ICloudTransport
  runSync: () => Promise<string | null>
  lastError: string | null
}

export function ICloudSection({ transport = icloudTransport, runSync, lastError }: Props) {
  const { t } = useTranslation()
  const [on, setOn] = useState(() => transport.isEnabled())
  const readLastSynced = () => { try { return localStorage.getItem(ICLOUD_LAST_SYNCED_KEY) } catch { return null } }
  const [lastSynced, setLastSynced] = useState<string | null>(readLastSynced)
  useEffect(() => {
    const timer = setInterval(() => setLastSynced(readLastSynced()), 5 * 1000)
    return () => clearInterval(timer)
  }, [])
  const [syncing, setSyncing] = useState(false)
  const [result, setResult] = useState<'idle' | 'ok' | 'error'>('idle')
  const [error, setError] = useState<string | null>(lastError)

  if (!transport.isSupported()) return null

  const toggle = () => {
    const next = !on
    transport.setEnabled(next)
    setOn(next)
    setResult('idle')
    if (next) void runSync()
  }
  const syncNow = async () => {
    setSyncing(true)
    setResult('idle')
    try {
      const err = await runSync()
      setLastSynced(readLastSynced())
      setError(err)
      setResult(err ? 'error' : 'ok')
    } finally { setSyncing(false) }
  }
  const when = (iso: string | null) => (iso ? formatDateTime(iso) : t('sync.neverSynced'))

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">{t('icloud.title')}</h3>
      <div className="flex items-center justify-between gap-3 py-1">
        <div className="min-w-0">
          <p className="text-sm text-slate-700 dark:text-slate-300">{t('icloud.switchLabel')}</p>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{on ? t('icloud.onHint') : t('icloud.offHint')}</p>
        </div>
        <button
          type="button"
          onClick={toggle}
          className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${on ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'}`}
          aria-checked={on}
          aria-label={t('icloud.switchLabel')}
          role="switch"
        >
          <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : ''}`} />
        </button>
      </div>
      {on && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <button type="button" onClick={syncNow} disabled={syncing} className={button}>
              {syncing && <Loader size={12} className="animate-spin" />}
              {t('sync.syncNow')}
            </button>
            {result === 'ok' && (
              <span className="flex items-center gap-1.5 text-xs text-green-500 dark:text-green-400">
                <CheckCircle size={13} />{t('sync.syncedDate', { date: when(lastSynced) })}
              </span>
            )}
            {result === 'error' && (
              <span className="flex items-center gap-1.5 text-xs text-red-500 dark:text-red-400">
                <XCircle size={13} />{t('sync.errors.iCloudUnavailable', { error: error ?? '' })}
              </span>
            )}
          </div>
          {result === 'idle' && <p className="text-xs text-slate-400 dark:text-slate-500">{t('sync.lastSynced', { date: when(lastSynced) })}</p>}
        </div>
      )}
    </div>
  )
}
