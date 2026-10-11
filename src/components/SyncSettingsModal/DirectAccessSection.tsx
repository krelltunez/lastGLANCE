import { useEffect, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle, Loader, XCircle } from 'lucide-react'
import { getSyncPassphrase, hasEncryptionReady } from '@glance-apps/sync'
import { directAccessTransport, DIRECT_ACCESS_LAST_SYNCED_KEY, type DirectAccessTransport } from '@/sync/directAccess'
import { setupEncryptionKey, CRYPTO_CONFIG } from '@/sync/engine'
import { isIOS } from '@/native/platform'
import { formatDateTime } from '@/utils/datetime'
import { decideEncryptToggle } from './directAccessToggle'
import { getMultiUserEnabled } from '@/multiuser/settings'
import { getDirectAccessIntentsEnabledFlag } from '@/intents/directAccessIntentsConfig'

// The Direct Access section of the Cloud Sync dialog (docs/direct-access.md):
// connect a folder (Android) or the sync file (iOS), the per-device on/off
// switch, the per-device encrypt switch, "Sync now" and the last-synced stamp.
// It renders the transport's own snapshot through useSyncExternalStore, so a
// folder that goes away or comes back shows without a re-open.

interface Props {
  transport?: DirectAccessTransport
  /** Runs a cycle now; from useDirectAccessSync. */
  runSync: () => Promise<void>
  /** The last folder error the cycle reported, or null. */
  lastError: string | null
}

const button = 'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 transition-colors'
const input = 'w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400'

function Switch({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${on ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'}`}
      aria-checked={on}
      aria-label={label}
      role="switch"
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-4' : ''}`} />
    </button>
  )
}

function FileRow({ hint, chosen, configured, busy, pick, create, forget, t }: {
  hint: string; chosen: string; configured: boolean; busy: boolean
  pick: () => Promise<void>; create: () => Promise<void>; forget: () => Promise<void>
  t: (key: string) => string
}) {
  return (
    <div className="space-y-2 pt-1">
      <p className="text-xs text-slate-400 dark:text-slate-500">{hint}</p>
      <p className="text-sm text-slate-700 dark:text-slate-300">{chosen}</p>
      <div className="flex items-center gap-3 flex-wrap">
        {configured ? (
          <>
            <button type="button" onClick={pick} disabled={busy} className={button}>{t('sync.directAccess.fileChange')}</button>
            <button type="button" onClick={forget} disabled={busy} className={button}>{t('sync.directAccess.fileForget')}</button>
          </>
        ) : (
          <>
            <button type="button" onClick={pick} disabled={busy} className={button}>{t('sync.directAccess.fileChoose')}</button>
            <button type="button" onClick={create} disabled={busy} className={button}>{t('sync.directAccess.fileCreate')}</button>
          </>
        )}
      </div>
    </div>
  )
}

export function DirectAccessSection({ transport = directAccessTransport, runSync, lastError }: Props) {
  const { t } = useTranslation()
  const status = useSyncExternalStore(transport.subscribe, transport.getSnapshot, transport.getSnapshot)
  const ios = isIOS()
  const [busy, setBusy] = useState(false)
  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true)
    try { await fn() } finally { setBusy(false) }
  }

  // The cycle stamps this on every real read; re-read it while the dialog is open.
  const readLastSynced = () => { try { return localStorage.getItem(DIRECT_ACCESS_LAST_SYNCED_KEY) } catch { return null } }
  const [lastSynced, setLastSynced] = useState<string | null>(readLastSynced)
  useEffect(() => {
    setLastSynced(readLastSynced())
    const timer = setInterval(() => setLastSynced(readLastSynced()), 5 * 1000)
    return () => clearInterval(timer)
  }, [status.status])

  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<'idle' | 'ok' | 'error'>('idle')
  const syncNow = async () => {
    setSyncing(true)
    setSyncResult('idle')
    try {
      await runSync()
      setLastSynced(readLastSynced())
      setSyncResult(transport.getSnapshot().status === 'connected' ? 'ok' : 'error')
    } finally { setSyncing(false) }
  }

  const [askPassphrase, setAskPassphrase] = useState(false)
  const [passphrase, setPassphrase] = useState('')
  const [confirm, setConfirm] = useState('')
  const [passphraseError, setPassphraseError] = useState('')
  const toggleEncrypt = () => {
    const action = decideEncryptToggle({ encrypt: status.encrypt, keyInMemory: hasEncryptionReady() || !!getSyncPassphrase() })
    if (action === 'off') { transport.setEncryptsWrites(false); setAskPassphrase(false); return }
    if (action === 'on') { transport.setEncryptsWrites(true); return }
    setPassphrase(''); setConfirm(''); setPassphraseError('')
    setAskPassphrase(true)
  }
  const submitPassphrase = run(async () => {
    const p = passphrase.trim()
    if (!p) return
    if (p !== confirm.trim()) { setPassphraseError(t('sync.pasphraseMismatch')); return }
    try {
      await setupEncryptionKey(p, CRYPTO_CONFIG)
    } catch (err) {
      setPassphraseError(err instanceof Error ? err.message : t('sync.failedToSetPassphrase'))
      return
    }
    transport.setEncryptsWrites(true)
    setAskPassphrase(false)
    setPassphrase(''); setConfirm('')
  })

  const formatLastSynced = (iso: string | null) => (iso ? formatDateTime(iso) : t('sync.neverSynced'))

  if (!status.supported) {
    return (
      <div className="space-y-3">
        <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">{t('sync.directAccess.title')}</h3>
        <p className="text-xs text-slate-400 dark:text-slate-500">{t('sync.directAccess.desc')}</p>
        <p className="text-xs text-slate-400 dark:text-slate-500">{t('sync.directAccess.unsupported')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">{t('sync.directAccess.title')}</h3>
      <div className="flex items-center justify-between gap-3 py-1">
        <div className="min-w-0">
          <p className="text-sm text-slate-700 dark:text-slate-300">{t('sync.directAccess.switchLabel')}</p>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">{t('sync.directAccess.desc')}</p>
          <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{ios ? t('sync.directAccess.iosHint') : t('sync.directAccess.androidHint')}</p>
        </div>
        {status.connected && (
          <Switch on={status.enabled} onClick={() => transport.setEnabled(!status.enabled)} label={t('sync.directAccess.switchLabel')} />
        )}
      </div>

      {status.pickError && (
        <p className="text-xs text-red-500 dark:text-red-400">{t('sync.directAccess.pickFailed', { reason: status.pickError })}</p>
      )}

      {!status.connected ? (
        <div className="space-y-2">
          <p className="text-xs text-slate-400 dark:text-slate-500">{ios ? t('sync.directAccess.notConnectedFile') : t('sync.directAccess.notConnected')}</p>
          <div className="flex items-center gap-3 flex-wrap">
            <button type="button" onClick={run(() => (ios ? transport.pickFile() : transport.pickFolder()))} disabled={busy || status.status === 'unknown'} className={button}>
              {ios ? t('sync.directAccess.chooseFile') : t('sync.directAccess.chooseFolder')}
            </button>
            {ios && (
              <button type="button" onClick={run(() => transport.createFile())} disabled={busy || status.status === 'unknown'} className={button}>
                {t('sync.directAccess.createFile')}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-slate-700 dark:text-slate-300">
            {t('sync.directAccess.connectedTo')} <span className="font-medium">{status.name}</span>
          </p>
          {status.status === 'unreachable' && (
            <p className="text-xs text-amber-700 dark:text-amber-300">{t('sync.directAccess.unreachable')}</p>
          )}
          <p className="text-xs text-slate-400 dark:text-slate-500">
            {status.enabled ? t('sync.directAccess.onHint') : t('sync.directAccess.offHint')}
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <button type="button" onClick={run(() => (ios ? transport.pickFile() : transport.pickFolder()))} disabled={busy} className={button}>
              {ios ? t('sync.directAccess.changeFile') : t('sync.directAccess.changeFolder')}
            </button>
            <button type="button" onClick={run(() => transport.disconnect())} disabled={busy} className={button}>
              {t('sync.directAccess.disconnect')}
            </button>
          </div>

          {status.enabled && (
            <div className="space-y-2 pt-1">
              <div className="flex items-center gap-3 flex-wrap">
                <button type="button" onClick={syncNow} disabled={busy || syncing || status.status !== 'connected'} className={button}>
                  {syncing && <Loader size={12} className="animate-spin" />}
                  {t('sync.syncNow')}
                </button>
                {syncResult === 'ok' && (
                  <span className="flex items-center gap-1.5 text-xs text-green-500 dark:text-green-400">
                    <CheckCircle size={13} />
                    {t('sync.syncedDate', { date: formatLastSynced(lastSynced) })}
                  </span>
                )}
                {syncResult === 'error' && (
                  <span className="flex items-center gap-1.5 text-xs text-red-500 dark:text-red-400">
                    <XCircle size={13} />
                    {lastError ? t('sync.errors.directAccessUnavailable', { error: lastError }) : t('sync.syncFailed')}
                  </span>
                )}
              </div>
              {syncResult === 'idle' && (
                <p className="text-xs text-slate-400 dark:text-slate-500">{t('sync.lastSynced', { date: formatLastSynced(lastSynced) })}</p>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 py-1">
            <div className="min-w-0">
              <p className="text-sm text-slate-700 dark:text-slate-300">{t('sync.directAccess.encrypt')}</p>
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                {status.encrypt ? t('sync.directAccess.encryptOnHint') : t('sync.directAccess.encryptHint')}
              </p>
            </div>
            <Switch on={status.encrypt} onClick={toggleEncrypt} label={t('sync.directAccess.encrypt')} />
          </div>
          {/* On iPhone and iPad the roster and the event set are bookmarked
              files of their own, since Files hands over no folder: each is
              picked (one another device created) or created (a first device). */}
          {ios && getMultiUserEnabled() && (
            <FileRow
              hint={t('sync.directAccess.rosterHint')}
              chosen={status.roster?.configured ? t('sync.directAccess.rosterChosen', { name: status.roster.name ?? '' }) : t('sync.directAccess.rosterNotChosen')}
              configured={!!status.roster?.configured}
              busy={busy}
              pick={run(() => transport.pickUsersFile())}
              create={run(() => transport.createUsersFile())}
              forget={run(() => transport.forgetUsersFile())}
              t={t}
            />
          )}
          {ios && getDirectAccessIntentsEnabledFlag() && (
            <FileRow
              hint={t('sync.directAccess.eventsHint')}
              chosen={status.events?.configured ? t('sync.directAccess.eventsChosen', { name: status.events.name ?? '' }) : t('sync.directAccess.eventsNotChosen')}
              configured={!!status.events?.configured}
              busy={busy}
              pick={run(() => transport.pickEventsFile())}
              create={run(() => transport.createEventsFile())}
              forget={run(() => transport.forgetEventsFile())}
              t={t}
            />
          )}

          {askPassphrase && (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void submitPassphrase() }}>
              <p className="text-xs text-slate-400 dark:text-slate-500">{t('sync.directAccess.encryptPassphraseHint')}</p>
              <input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder={t('sync.choosePassphrase')} autoComplete="new-password" className={input} />
              <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={t('sync.reEnterPassphrase')} autoComplete="new-password" className={input} />
              {passphraseError && <p className="text-xs text-red-500 dark:text-red-400">{passphraseError}</p>}
              <div className="flex items-center gap-3">
                <button type="submit" disabled={busy || !passphrase.trim()} className={button}>{t('sync.directAccess.encryptTurnOn')}</button>
                <button type="button" disabled={busy} onClick={() => setAskPassphrase(false)} className={button}>{t('sync.directAccess.cancel')}</button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  )
}
