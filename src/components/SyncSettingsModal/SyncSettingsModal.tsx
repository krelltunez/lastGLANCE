import { useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader, AlertTriangle, CheckCircle, XCircle, ShieldAlert } from 'lucide-react'
import type { SyncEngine, DbSyncEngine, SyncErrorCode } from '@glance-apps/sync'
import { setupEncryptionKey, clearEncryptionKey, ensureSyncFolder, resetEnsuredFolder, CRYPTO_CONFIG, getRemoteBackupsEnabled, setRemoteBackupsEnabled, DEFAULT_SYNC_FOLDER, SYNC_FOLDER_KEY } from '@/sync/engine'
import { syncErrorText } from '@/sync/syncErrorText'
import { getVaultConfig, setVaultConfig } from '@/sync/vaultConfig'
import { testVaultConnection } from '@/sync/testVaultConnection'
import { cloudSyncProviders } from '@/utils/cloudSyncProviders'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from 'react-i18next'
import { isWebCryptoAvailable } from '@/utils/secureContext'

interface Props {
  engine: SyncEngine | null
  dbEngine: DbSyncEngine | null
  // Latest error from each transport's onError callback. Both engines swallow
  // sync errors internally (resolving rather than throwing), so these carry the
  // reason a manual sync failed. The accompanying typed code (null when the engine
  // sent none) is localized here at render time via syncErrorText.
  syncError: string | null
  syncErrorCode: SyncErrorCode | null
  vaultSyncError: string | null
  vaultSyncErrorCode: SyncErrorCode | null
  // Count of rows the last vault cycle could not decrypt (1.5.0 per-row
  // quarantine). Shown as a durable amber note so a key mismatch on some rows is
  // visible after the transient toast dismisses.
  vaultSkipped: number
  onClose: () => void
}

type TestStatus = 'idle' | 'testing' | 'ok' | 'fail'
type SyncResult = 'idle' | 'ok' | 'error'

// Messages for the vault "Test connection" failure outcomes. Hardcoded English
// to match the rest of the GLANCEvault (beta) section, which is not localized.
const VAULT_TEST_FAIL_TEXT: Record<'AUTH_FAILURE' | 'FORBIDDEN' | 'NETWORK_ERROR', string> = {
  AUTH_FAILURE: 'Device token is incorrect.',
  FORBIDDEN: 'Account ID not found or not permitted for this token.',
  NETWORK_ERROR: 'Could not reach the vault at this URL.',
}

export function SyncSettingsModal({ engine, dbEngine, syncError, syncErrorCode, vaultSyncError, vaultSyncErrorCode, vaultSkipped, onClose }: Props) {
  const { t } = useTranslation()
  const existingConfig = engine?.getConfig() ?? null
  const initFolder = localStorage.getItem(SYNC_FOLDER_KEY) ?? DEFAULT_SYNC_FOLDER

  const [provider, setProvider] = useState<string>(() => (existingConfig?.provider as string) ?? 'nextcloud')
  const [formData, setFormData] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {}
    Object.values(cloudSyncProviders).forEach(p => {
      p.configFields.forEach(f => { initial[f.key] = (existingConfig?.[f.key] as string) ?? '' })
    })
    return initial
  })

  const [folderPath, setFolderPath] = useState(() => initFolder)
  const originalFolder = useRef(initFolder)

  const [testStatus, setTestStatus] = useState<TestStatus>('idle')
  const [testError, setTestError] = useState('')

  // Master on/off for the WebDAV cloud sync. When off, the engine config is
  // persisted with enabled:false — credentials are kept but all auto-sync and
  // manual sync are paused. Defaults to on for new setups so filling in the
  // connection fields activates sync as before.
  const [syncEnabled, setSyncEnabled] = useState(() => Boolean(existingConfig?.enabled ?? true))

  const [encEnabled, setEncEnabled] = useState(() => engine?.hasEncryptionReady() ?? false)
  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  const [showPassphraseInput, setShowPassphraseInput] = useState(false)
  const [encSaving, setEncSaving] = useState(false)
  const [encError, setEncError] = useState('')
  // Enabling encryption derives a key via Web Crypto (crypto.subtle), which is
  // only available in a secure context. Over plain HTTP on a LAN IP/hostname it
  // is absent, so gate the toggle and explain rather than throwing on submit.
  const cryptoAvailable = isWebCryptoAvailable()

  const [remoteBackupsEnabled, setRemoteBackupsEnabledState] = useState(() => getRemoteBackupsEnabled())

  // GLANCEvault (beta) DB transport config. Stored separately from the WebDAV
  // config; enabling it makes the app build a DB engine alongside the file one.
  const initVault = useRef(getVaultConfig())
  const [vaultEnabled, setVaultEnabled] = useState(() => initVault.current?.enabled ?? false)
  const [vaultUrl, setVaultUrl] = useState(() => initVault.current?.vaultUrl ?? '')
  const [vaultToken, setVaultToken] = useState(() => initVault.current?.vaultToken ?? '')
  const [vaultAccountId, setVaultAccountId] = useState(() => initVault.current?.accountId ?? '')

  // Pre-save connection test for the vault credentials. 'ok' covers both good
  // states (account initialized, or a fresh account with no salt yet); the
  // message distinguishes them. Reset to idle whenever a field changes so a stale
  // result can't outlive the credentials it verified.
  const [vaultTestStatus, setVaultTestStatus] = useState<TestStatus>('idle')
  const [vaultTestMsg, setVaultTestMsg] = useState('')
  const vaultFieldsFilled = Boolean(vaultUrl.trim() && vaultToken.trim() && vaultAccountId.trim())

  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<SyncResult>('idle')
  const [syncResultMsg, setSyncResultMsg] = useState('')
  const [lastSynced, setLastSynced] = useState(() => engine?.getLastSynced() ?? null)

  // GLANCEvault manual sync runs the DB engine's own cycle, independent of the
  // WebDAV file sync above.
  const [vaultSyncing, setVaultSyncing] = useState(false)
  const [vaultSyncResult, setVaultSyncResult] = useState<SyncResult>('idle')
  const [vaultSyncResultMsg, setVaultSyncResultMsg] = useState('')
  const [vaultLastSynced, setVaultLastSynced] = useState(() => dbEngine?.getLastSynced() ?? null)

  const halted = engine?.isHardStopped() ?? false

  const activeProvider = cloudSyncProviders[provider]
  const requiredFieldsFilled = activeProvider?.configFields.every(f => formData[f.key]) ?? false

  function saveConfig() {
    // GLANCEvault config is independent of the file engine: only saved when the
    // toggle is on, cleared (reverting to file tier) when off.
    const prevVault = initVault.current
    const nextVault = vaultEnabled
      ? { enabled: true, vaultUrl: vaultUrl.trim(), vaultToken: vaultToken.trim(), accountId: vaultAccountId.trim() }
      : null
    setVaultConfig(nextVault)
    const vaultChanged =
      (prevVault?.enabled ?? false) !== (nextVault?.enabled ?? false) ||
      (prevVault?.vaultUrl ?? '') !== (nextVault?.vaultUrl ?? '') ||
      (prevVault?.vaultToken ?? '') !== (nextVault?.vaultToken ?? '') ||
      (prevVault?.accountId ?? '') !== (nextVault?.accountId ?? '')

    if (engine) {
      engine.setConfig(requiredFieldsFilled ? { provider, ...formData, syncFolder: folderPath, enabled: syncEnabled, encryptionEnabled: encEnabled } : null)
      localStorage.setItem(SYNC_FOLDER_KEY, folderPath)
      resetEnsuredFolder()
    }
    // A folder change or any vault change requires a reload so the engines are
    // reconstructed with the new transport config on next mount.
    if (folderPath !== originalFolder.current || vaultChanged) {
      window.location.reload()
    }
  }

  function handleClose() {
    saveConfig()
    onClose()
  }

  useEscapeKey(handleClose)

  async function handleTest() {
    if (!engine || !requiredFieldsFilled) return
    setTestStatus('testing')
    setTestError('')
    try {
      const result = await engine.test({ provider, ...formData })
      if (result.success) {
        setTestStatus('ok')
      } else {
        setTestStatus('fail')
        setTestError(result.error ?? t('sync.testFailed'))
      }
    } catch (err) {
      setTestStatus('fail')
      setTestError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleEnableEncryption() {
    if (!passphrase.trim()) return
    if (passphrase !== confirmPassphrase) {
      setEncError(t('sync.pasphraseMismatch'))
      return
    }
    setEncSaving(true)
    setEncError('')
    try {
      await setupEncryptionKey(passphrase.trim(), CRYPTO_CONFIG)
      setEncEnabled(true)
      const cfg = engine?.getConfig()
      if (cfg) {
        engine?.setConfig({ ...cfg, encryptionEnabled: true })
        engine?.upload().catch(() => {/* non-fatal; next sync will re-attempt */})
      }
      setShowPassphraseInput(false)
      setPassphrase('')
      setConfirmPassphrase('')
    } catch (err) {
      setEncError(err instanceof Error ? err.message : t('sync.failedToSetPassphrase'))
    } finally {
      setEncSaving(false)
    }
  }

  async function handleDisableEncryption() {
    setEncSaving(true)
    setEncError('')
    try {
      await clearEncryptionKey(CRYPTO_CONFIG)
      setEncEnabled(false)
      const cfg = engine?.getConfig()
      if (cfg) {
        engine?.setConfig({ ...cfg, encryptionEnabled: false })
        engine?.upload().catch(() => {/* non-fatal; next sync will re-attempt */})
      }
    } catch (err) {
      setEncError(err instanceof Error ? err.message : t('sync.failedToClearKey'))
    } finally {
      setEncSaving(false)
    }
  }

  // Both engines report sync failures through their onError callback and resolve
  // their sync promise either way — they only advance the stored "last synced"
  // timestamp on success. So we treat an advanced timestamp as success and a
  // resolved-but-unchanged one as failure, and read the reason from the engine's
  // last error (threaded in from App). The try/catch still guards the few paths
  // that do throw (e.g. ensureSyncFolder).
  async function handleSyncNow() {
    if (!engine || syncing || engine.isSyncing()) return
    saveConfig()
    setSyncing(true)
    setSyncResult('idle')
    setSyncResultMsg('')
    const before = engine.getLastSynced()
    try {
      await ensureSyncFolder(engine)
      await engine.sync()
    } catch (err) {
      setSyncResult('error')
      setSyncResultMsg(err instanceof Error ? err.message : t('sync.syncFailed'))
      setSyncing(false)
      return
    }
    const after = engine.getLastSynced()
    if (after && after !== before) {
      setLastSynced(after)
      setSyncResult('ok')
    } else {
      setSyncResult('error')
    }
    setSyncing(false)
  }

  // Verify the entered vault credentials BEFORE they are saved/activated, using
  // the same authenticated getSalt probe the intents key setup uses (native-safe
  // via vaultFetchImpl). Mirrors the WebDAV "Test connection" UX, but the logic
  // is the vault probe — it never runs engine.test() or saves anything.
  async function handleVaultTest() {
    if (!vaultFieldsFilled) return
    setVaultTestStatus('testing')
    setVaultTestMsg('')
    const outcome = await testVaultConnection({
      vaultUrl: vaultUrl.trim(),
      vaultToken: vaultToken.trim(),
      accountId: vaultAccountId.trim(),
    })
    if (outcome.ok) {
      setVaultTestStatus('ok')
      // A fresh account legitimately has no salt yet — this is success, not a
      // failure; the salt is established on the first sync.
      setVaultTestMsg(
        outcome.salt
          ? 'Connected.'
          : 'Connected — this account will be initialized on first sync.',
      )
    } else {
      setVaultTestStatus('fail')
      setVaultTestMsg(VAULT_TEST_FAIL_TEXT[outcome.code])
    }
  }

  async function handleVaultSyncNow() {
    if (!dbEngine || vaultSyncing || dbEngine.isSyncing()) return
    setVaultSyncing(true)
    setVaultSyncResult('idle')
    setVaultSyncResultMsg('')
    const before = dbEngine.getLastSynced()
    try {
      await dbEngine.dbSyncCycle()
    } catch (err) {
      setVaultSyncResult('error')
      setVaultSyncResultMsg(err instanceof Error ? err.message : t('sync.syncFailed'))
      setVaultSyncing(false)
      return
    }
    const after = dbEngine.getLastSynced()
    if (after && after !== before) {
      setVaultLastSynced(after)
      setVaultSyncResult('ok')
    } else {
      setVaultSyncResult('error')
    }
    setVaultSyncing(false)
  }

  function formatLastSynced(iso: string | null): string {
    if (!iso) return t('sync.neverSynced')
    const d = new Date(iso)
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center app-safe-bottom bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) handleClose() }}
    >
      <div className="w-full sm:max-w-md bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/50 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 shrink-0">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">{t('sync.title')}</h2>
          <button
            onClick={handleClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 px-6 pb-4 space-y-5">

          <p className="text-sm text-slate-400 dark:text-slate-500">{t('sync.autoSaveHint')}</p>

          {/* Hard stop warning */}
          {halted && (
            <div className="flex items-start gap-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40">
              <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-amber-700 dark:text-amber-300 font-medium">{t('sync.syncHalted')}</p>
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                  {t('sync.haltedDescription')}
                </p>
              </div>
              <button
                onClick={() => { engine?.clearHardStop() }}
                className="text-xs text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 font-medium shrink-0 underline"
              >
                {t('sync.clearHalt')}
              </button>
            </div>
          )}

          {/* Connection section */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              {t('sync.webdavConnection')}
            </h3>

            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm text-slate-700 dark:text-slate-300">{t('sync.syncEnabledLabel')}</p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                  {syncEnabled ? t('sync.syncActive') : t('sync.syncInactive')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSyncEnabled(v => !v)}
                className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${syncEnabled ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'}`}
                aria-checked={syncEnabled}
                role="switch"
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${syncEnabled ? 'translate-x-4' : ''}`} />
              </button>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                {t('sync.provider')}
              </label>
              <select
                value={provider}
                onChange={e => { setProvider(e.target.value); setTestStatus('idle'); setTestError('') }}
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              >
                {Object.entries(cloudSyncProviders).map(([key, p]) => (
                  <option key={key} value={key}>{p.name}</option>
                ))}
              </select>
            </div>

            {activeProvider?.configFields.map(field => (
              <div key={field.key}>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                  {field.label}
                </label>
                <input
                  type={field.type}
                  value={formData[field.key] ?? ''}
                  onChange={e => setFormData(prev => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={field.placeholder}
                  autoComplete={field.type === 'password' ? 'current-password' : field.key === 'username' ? 'username' : 'off'}
                  className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                />
                {field.type === 'password' && (
                  <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{t('sync.passwordHint')}</p>
                )}
              </div>
            ))}

            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                {t('sync.folderLabel')}
              </label>
              <input
                type="text"
                value={folderPath}
                onChange={e => setFolderPath(e.target.value)}
                placeholder={DEFAULT_SYNC_FOLDER}
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                {t('sync.folderHint')}
              </p>
            </div>

            {activeProvider?.helpText && (
              <p className="text-xs text-slate-400 dark:text-slate-500">{activeProvider.helpText}</p>
            )}

            <div className="space-y-2 pt-1">
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={handleTest}
                  disabled={testStatus === 'testing' || !requiredFieldsFilled}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 transition-colors"
                >
                  {testStatus === 'testing' && <Loader size={12} className="animate-spin" />}
                  {t('sync.testConnection')}
                </button>
                <button
                  onClick={handleSyncNow}
                  disabled={!engine || !syncEnabled || syncing || (engine?.isSyncing() ?? false)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 transition-colors"
                >
                  {syncing && <Loader size={12} className="animate-spin" />}
                  {t('sync.syncNow')}
                </button>
                {testStatus === 'ok' && (
                  <span className="text-xs text-green-500 dark:text-green-400">{t('sync.connected')}</span>
                )}
                {testStatus === 'fail' && (
                  <span className="text-xs text-red-500 dark:text-red-400">{testError || t('sync.testFailed')}</span>
                )}
              </div>
              {syncResult === 'ok' && (
                <span className="flex items-center gap-1.5 text-xs text-green-500 dark:text-green-400">
                  <CheckCircle size={13} />
                  {t('sync.syncedDate', { date: formatLastSynced(lastSynced) })}
                </span>
              )}
              {syncResult === 'error' && (
                <span className="flex items-center gap-1.5 text-xs text-red-500 dark:text-red-400">
                  <XCircle size={13} />
                  {syncResultMsg || syncErrorText(t, syncError, syncErrorCode) || t('sync.syncFailed')}
                </span>
              )}
              {syncResult === 'idle' && lastSynced && (
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  {t('sync.lastSynced', { date: formatLastSynced(lastSynced) })}
                </p>
              )}
            </div>
          </div>

          {/* Encryption section */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              {t('sync.encryptionSection')}
            </h3>

            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm text-slate-700 dark:text-slate-300">{t('sync.encryptSyncData')}</p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                  {encEnabled ? t('sync.encryptionActive') : t('sync.encryptionInactive')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (encEnabled) {
                    handleDisableEncryption()
                  } else {
                    setShowPassphraseInput(p => !p)
                    setPassphrase('')
                    setConfirmPassphrase('')
                    setEncError('')
                  }
                }}
                disabled={encSaving || (!encEnabled && !cryptoAvailable)}
                className={`relative w-10 h-6 rounded-full transition-colors disabled:opacity-40 ${encEnabled ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'}`}
                aria-checked={encEnabled}
                role="switch"
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${encEnabled ? 'translate-x-4' : ''}`} />
              </button>
            </div>

            {!encEnabled && !cryptoAvailable && (
              <div className="flex items-start gap-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3">
                <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-500 dark:text-amber-400" />
                <p className="text-sm text-amber-700 dark:text-amber-300">
                  {t('passphrase.insecureContext')}
                </p>
              </div>
            )}

            {showPassphraseInput && !encEnabled && cryptoAvailable && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    {t('sync.syncPassphrase')}
                  </label>
                  <input
                    type="password"
                    value={passphrase}
                    onChange={e => setPassphrase(e.target.value)}
                    placeholder={t('sync.choosePassphrase')}
                    autoComplete="new-password"
                    className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    {t('sync.passphraseConfirm')}
                  </label>
                  <input
                    type="password"
                    value={confirmPassphrase}
                    onChange={e => setConfirmPassphrase(e.target.value)}
                    placeholder={t('sync.reEnterPassphrase')}
                    autoComplete="new-password"
                    onKeyDown={e => { if (e.key === 'Enter') handleEnableEncryption() }}
                    className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                  />
                </div>
                <div className="rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40 px-4 py-3 space-y-1">
                  <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">{t('sync.importantNote')}</p>
                  <p className="text-xs text-amber-700 dark:text-amber-300">{t('sync.passphraseNotice')}</p>
                </div>
                <button
                  onClick={handleEnableEncryption}
                  disabled={!passphrase.trim() || !confirmPassphrase.trim() || encSaving}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-green-400 text-white hover:bg-green-300 disabled:opacity-40 transition-colors"
                >
                  {encSaving && <Loader size={12} className="animate-spin" />}
                  {t('sync.setPassphrase')}
                </button>
              </div>
            )}

            {encError && (
              <p className="text-xs text-red-500 dark:text-red-400">{encError}</p>
            )}
          </div>

          {/* Remote backups section */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              {t('sync.remoteBackupsSection')}
            </h3>
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm text-slate-700 dark:text-slate-300">{t('sync.autoBackup')}</p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                  {t('sync.autoBackupHint')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  const next = !remoteBackupsEnabled
                  setRemoteBackupsEnabled(next)
                  setRemoteBackupsEnabledState(next)
                }}
                className={`relative w-10 h-6 rounded-full transition-colors ${remoteBackupsEnabled ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'}`}
                aria-checked={remoteBackupsEnabled}
                role="switch"
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${remoteBackupsEnabled ? 'translate-x-4' : ''}`} />
              </button>
            </div>
          </div>

          {/* GLANCEvault (beta) section */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              GLANCEvault (beta)
            </h3>
            <p className="text-xs text-amber-600 dark:text-amber-400">
              ⚠️ Experimental. Requires a self-hosted GLANCEvault server. Not recommended for most users.
            </p>
            <div className="flex items-center justify-between gap-3 py-1">
              <div className="min-w-0">
                <p className="text-sm text-slate-700 dark:text-slate-300">Sync via GLANCEvault</p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                  Row-grained database sync. Runs alongside your existing WebDAV sync. Your WebDAV data is never modified.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setVaultEnabled(v => !v)}
                className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${vaultEnabled ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'}`}
                aria-checked={vaultEnabled}
                role="switch"
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${vaultEnabled ? 'translate-x-4' : ''}`} />
              </button>
            </div>

            {vaultEnabled && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Vault URL
                  </label>
                  <input
                    type="text"
                    value={vaultUrl}
                    onChange={e => { setVaultUrl(e.target.value); setVaultTestStatus('idle'); setVaultTestMsg('') }}
                    placeholder="https://vault.glance-apps.com"
                    autoComplete="off"
                    className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Device token
                  </label>
                  <input
                    type="password"
                    value={vaultToken}
                    onChange={e => { setVaultToken(e.target.value); setVaultTestStatus('idle'); setVaultTestMsg('') }}
                    placeholder="Bearer token"
                    autoComplete="off"
                    className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                    Account ID
                  </label>
                  <input
                    type="text"
                    value={vaultAccountId}
                    onChange={e => { setVaultAccountId(e.target.value); setVaultTestStatus('idle'); setVaultTestMsg('') }}
                    placeholder="Household account id"
                    autoComplete="off"
                    className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                  />
                </div>
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  Saved on close. The app reloads to apply vault changes. Uses your sync passphrase for encryption.
                </p>

                {/* Pre-save credential verification. Mirrors the WebDAV "Test
                    connection" button, but runs the vault getSalt probe so bad
                    credentials are caught here instead of failing at first sync. */}
                <div className="space-y-2 pt-1">
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      onClick={handleVaultTest}
                      disabled={vaultTestStatus === 'testing' || !vaultFieldsFilled}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 transition-colors"
                    >
                      {vaultTestStatus === 'testing' && <Loader size={12} className="animate-spin" />}
                      {t('sync.testConnection')}
                    </button>
                    {vaultTestStatus === 'ok' && (
                      <span className="flex items-center gap-1.5 text-xs text-green-500 dark:text-green-400">
                        <CheckCircle size={13} />
                        {vaultTestMsg}
                      </span>
                    )}
                    {vaultTestStatus === 'fail' && (
                      <span className="flex items-center gap-1.5 text-xs text-red-500 dark:text-red-400">
                        <XCircle size={13} />
                        {vaultTestMsg}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            )}

            {vaultEnabled && (
              <div className="space-y-2 pt-1">
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    onClick={handleVaultSyncNow}
                    disabled={!dbEngine || vaultSyncing || (dbEngine?.isSyncing() ?? false)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 transition-colors"
                  >
                    {vaultSyncing && <Loader size={12} className="animate-spin" />}
                    {t('sync.syncNow')}
                  </button>
                  {vaultSyncResult === 'ok' && (
                    <span className="flex items-center gap-1.5 text-xs text-green-500 dark:text-green-400">
                      <CheckCircle size={13} />
                      {t('sync.syncedDate', { date: formatLastSynced(vaultLastSynced) })}
                    </span>
                  )}
                  {vaultSyncResult === 'error' && (
                    <span className="flex items-center gap-1.5 text-xs text-red-500 dark:text-red-400">
                      <XCircle size={13} />
                      {vaultSyncResultMsg || syncErrorText(t, vaultSyncError, vaultSyncErrorCode) || t('sync.syncFailed')}
                    </span>
                  )}
                </div>
                {vaultSyncResult === 'idle' && (
                  <p className="text-xs text-slate-400 dark:text-slate-500">
                    {dbEngine
                      ? t('sync.lastSynced', { date: formatLastSynced(vaultLastSynced) })
                      : 'Save & reload to activate GLANCEvault sync.'}
                  </p>
                )}
                {vaultSkipped > 0 && (
                  <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40">
                    <AlertTriangle size={14} className="text-amber-500 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700 dark:text-amber-300">
                      {vaultSkipped} {vaultSkipped === 1 ? 'item' : 'items'} couldn’t be read on the last sync.
                      This usually means a wrong sync passphrase on some rows. They’re skipped and retried
                      automatically on later syncs — nothing was lost or overwritten.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-700/40 shrink-0">
          <button
            onClick={handleClose}
            className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
          >
            {t('sync.saveClose')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
