import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader } from 'lucide-react'
import { hasEncryptionReady, getSyncPassphrase } from '@glance-apps/sync'
import {
  type IntentsConfig,
  DEFAULT_CONFIG,
  saveIntentsConfig,
  clearActivityLog,
  getActivityLog,
} from '@/intents/config'
import { getDbIntentsConfig, saveDbIntentsConfig } from '@/intents/dbConfig'
import { getVaultConfig } from '@/sync/vaultConfig'
import { ActivityLogModal } from '@/components/ActivityLogModal/ActivityLogModal'
import { PassphraseModal } from '@/components/PassphraseModal/PassphraseModal'
import { testConnection } from '@/intents/webdav'
import { loadIntentsRootKey, clearIntentsRootKey } from '@/intents/intentsKeyStore'
import { loadVaultIntentsRootKey } from '@/intents/vaultIntentsKeyStore'
import { setupIntentsEncryption } from '@/intents/setupIntentsEncryption'
import { setupVaultIntentsEncryption, ensureVaultIntentsKey, VaultConnMissingError, VaultSaltMissingError } from '@/intents/setupVaultIntentsEncryption'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from 'react-i18next'

interface Props {
  onClose: () => void
  onSaved: () => void
}

type TestStatus = 'idle' | 'testing' | 'ok' | 'fail'

interface LocalConfig extends IntentsConfig {}

export function IntegrationSettingsModal({ onClose, onSaved }: Props) {
  const { t } = useTranslation()
  const [localConfig, setLocalConfig] = useState<LocalConfig>(() => {
    try {
      const raw = localStorage.getItem('lg_intents_config')
      if (!raw) return { ...DEFAULT_CONFIG }
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
    } catch {
      return { ...DEFAULT_CONFIG }
    }
  })

  const [testStatus, setTestStatus] = useState<TestStatus>('idle')
  const [testError, setTestError] = useState('')
  const [showActivityLog, setShowActivityLog] = useState(false)
  const [hasActivity, setHasActivity] = useState(() => getActivityLog().length > 0)
  const [rootKeyReady, setRootKeyReady] = useState<boolean | null>(null)
  const [showPassphraseInput, setShowPassphraseInput] = useState(false)
  const [passphraseInput, setPassphraseInput] = useState('')
  const [setupError, setSetupError] = useState('')
  const [saving, setSaving] = useState(false)

  // GLANCEvault DB intents transport (beta). Independent of the WebDAV intents
  // config above and of the vault SYNC toggle: this only flips the `enabled`
  // flag in lg_db_intents_config. The connection (URL/token/accountId) is NOT
  // entered here — the transport inherits it from the GLANCEvault sync config
  // (getVaultConfig), so the UI shows whether that connection is present rather
  // than duplicating the fields.
  const [dbIntentsEnabled, setDbIntentsEnabled] = useState(() => getDbIntentsConfig().enabled)
  const initialDbIntentsEnabled = useRef(getDbIntentsConfig().enabled)
  const vaultConn = getVaultConfig()
  const vaultConfigured = !!(vaultConn?.vaultUrl && vaultConn?.vaultToken && vaultConn?.accountId)

  // Interactive passphrase prompt for the vault intents key setup. promptForVault
  // Passphrase() shows the shared sync PassphraseModal and resolves with the
  // entered passphrase, or null if the user cancels.
  const [showVaultPassphrase, setShowVaultPassphrase] = useState(false)
  const vaultPassResolver = useRef<((p: string | null) => void) | null>(null)
  function promptForVaultPassphrase(): Promise<string | null> {
    return new Promise(resolve => {
      vaultPassResolver.current = resolve
      setShowVaultPassphrase(true)
    })
  }

  const encReady = hasEncryptionReady()

  useEffect(() => {
    loadIntentsRootKey().then(key => setRootKeyReady(key !== null))
  }, [])

  useEscapeKey(showActivityLog || showVaultPassphrase ? () => {} : onClose)

  function set<K extends keyof LocalConfig>(key: K, value: LocalConfig[K]) {
    setLocalConfig(prev => ({ ...prev, [key]: value }))
  }

  function handleEncryptionToggle() {
    const newEnabled = !localConfig.encryptionEnabled
    set('encryptionEnabled', newEnabled)
    setSetupError('')
    if (newEnabled && !rootKeyReady) {
      setShowPassphraseInput(getSyncPassphrase() === null)
    } else {
      setShowPassphraseInput(false)
      setPassphraseInput('')
    }
  }

  async function handleTestConnection() {
    setTestStatus('testing')
    setTestError('')
    try {
      const result = await testConnection(
        localConfig.webdavUrl,
        localConfig.folderPath,
        localConfig.webdavUsername,
        localConfig.webdavPassword,
      )
      if (result.success) {
        setTestStatus('ok')
      } else {
        setTestStatus('fail')
        setTestError(result.error ?? t('integration.connectionFailed'))
      }
    } catch (err) {
      setTestStatus('fail')
      setTestError(err instanceof Error ? err.message : String(err))
    }
  }

  async function handleSave() {
    setSaving(true)
    setSetupError('')
    try {
      // ── Vault intents key setup (stage 2b-i) ────────────────────────────────
      // Run BEFORE any other save side effect and BEFORE the reload below, so the
      // vault intents key is derived while the passphrase is available and is
      // already cached in its slot when the app reloads. The vault deliverer
      // reads that cached key (else returns transient), so without this the
      // transport could never send.
      //
      // Trigger: vault intents is being turned on (off->on) OR is on with no key
      // cached yet. If a key is already cached, do nothing.
      if (dbIntentsEnabled) {
        const r = await ensureVaultIntentsKey({
          loadCachedKey: loadVaultIntentsRootKey,
          getPassphrase: getSyncPassphrase,
          promptForPassphrase: promptForVaultPassphrase,
          derive: setupVaultIntentsEncryption,
        })
        if (r.status !== 'ready') {
          // Cancelled or failed: never enable vault intents without a derived key.
          setDbIntentsEnabled(false)
          if (r.status === 'cancelled') setSetupError(t('integration.vaultIntentsEncryptionRequired'))
          else if (r.error instanceof VaultSaltMissingError) setSetupError(t('integration.vaultIntentsSaltMissing'))
          else if (r.error instanceof VaultConnMissingError) setSetupError(t('integration.vaultIntentsNoConnection'))
          else setSetupError(t('integration.setupFailed'))
          return
        }
      }

      if (localConfig.encryptionEnabled && !rootKeyReady) {
        const passphrase = getSyncPassphrase() ?? passphraseInput.trim()
        if (!passphrase) {
          setSetupError(t('integration.passphraseRequired'))
          return
        }
        await setupIntentsEncryption(localConfig, passphrase)
        setRootKeyReady(true)
        setShowPassphraseInput(false)
        setPassphraseInput('')
      } else if (!localConfig.encryptionEnabled && rootKeyReady) {
        await clearIntentsRootKey()
        setRootKeyReady(false)
      }
      saveIntentsConfig(localConfig)

      // Persist the DB intents flag SEPARATELY, leaving the WebDAV intents config
      // (saved just above) and the vault sync config untouched. Spread the
      // existing config so ttlMs/pollIntervalMinutes are preserved and the
      // written object matches the exact shape getDbIntentsConfig() reads.
      const dbIntentsChanged = dbIntentsEnabled !== initialDbIntentsEnabled.current
      saveDbIntentsConfig({ ...getDbIntentsConfig(), enabled: dbIntentsEnabled })

      onSaved()
      onClose()

      // Reload on an enable change so useDbIntentsPoller remounts with the new
      // config, mirroring how the vault sync toggle reloads to reconstruct its
      // engine. (Sending already re-reads the gate per call; this is for the
      // receive poller's cadence/startup.)
      if (dbIntentsChanged) window.location.reload()
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : t('integration.setupFailed'))
    } finally {
      setSaving(false)
    }
  }

  const modal = createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-lg bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/50 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 shrink-0">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">
            {t('integration.title')}
          </h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 px-6 pb-4 space-y-5">
          {/* Connection section */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              {t('integration.connectionSection')}
            </h3>

            {/* Enable toggle */}
            <div className="flex items-center justify-between py-1">
              <span className="text-sm text-slate-700 dark:text-slate-300">{t('integration.enableIntegration')}</span>
              <button
                type="button"
                onClick={() => set('enabled', !localConfig.enabled)}
                className={`relative w-10 h-6 rounded-full transition-colors ${localConfig.enabled ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'}`}
                aria-checked={localConfig.enabled}
                role="switch"
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${localConfig.enabled ? 'translate-x-4' : ''}`} />
              </button>
            </div>

            {/* WebDAV URL */}
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                {t('integration.webdavUrl')}
              </label>
              <input
                type="url"
                value={localConfig.webdavUrl}
                onChange={e => set('webdavUrl', e.target.value)}
                placeholder={t('integration.webdavUrlPlaceholder')}
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                {t('integration.webdavUrlHint')}
              </p>
            </div>

            {/* Username */}
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                {t('integration.username')}
              </label>
              <input
                type="text"
                value={localConfig.webdavUsername}
                onChange={e => set('webdavUsername', e.target.value)}
                placeholder={t('integration.usernamePlaceholder')}
                autoComplete="username"
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                {t('integration.password')}
              </label>
              <input
                type="password"
                value={localConfig.webdavPassword}
                onChange={e => set('webdavPassword', e.target.value)}
                placeholder={t('integration.passwordPlaceholder')}
                autoComplete="current-password"
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">{t('integration.passwordHint')}</p>
            </div>

            {/* Folder path */}
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                {t('integration.folderPath')}
              </label>
              <input
                type="text"
                value={localConfig.folderPath}
                onChange={e => set('folderPath', e.target.value)}
                placeholder={t('integration.folderPathPlaceholder')}
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
            </div>

            {/* Test connection button */}
            <div className="flex items-center gap-3">
              <button
                onClick={handleTestConnection}
                disabled={testStatus === 'testing' || !localConfig.webdavUrl || !localConfig.webdavUsername || !localConfig.webdavPassword}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 transition-colors"
              >
                {testStatus === 'testing' ? (
                  <Loader size={12} className="animate-spin" />
                ) : null}
                {t('integration.testConnection')}
              </button>
              {testStatus === 'ok' && (
                <span className="text-xs text-green-500 dark:text-green-400">{t('integration.connected')}</span>
              )}
              {testStatus === 'fail' && (
                <span className="text-xs text-red-500 dark:text-red-400">{testError || t('integration.connectionFailed')}</span>
              )}
            </div>
          </div>

          {/* Polling section */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              {t('integration.pollingSection')}
            </h3>
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                {t('integration.pollInterval')}
              </label>
              <input
                type="number"
                min="1"
                max="1440"
                value={localConfig.pollIntervalMinutes}
                onChange={e => set('pollIntervalMinutes', Math.max(1, parseInt(e.target.value, 10) || 15))}
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
            </div>
          </div>

          {/* Encryption section */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              {t('integration.encryptionSection')}
            </h3>
            <div className="flex items-start justify-between py-1">
              <div>
                <p className={`text-sm ${encReady ? 'text-slate-700 dark:text-slate-300' : 'text-slate-400 dark:text-slate-500'}`}>
                  {t('integration.encryptIntents')}
                </p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                  {encReady
                    ? rootKeyReady
                      ? t('integration.encryptionActiveHint')
                      : t('integration.encryptionSyncHint')
                    : t('integration.encryptionRequiresSync')}
                </p>
              </div>
              <button
                type="button"
                disabled={!encReady || saving}
                onClick={handleEncryptionToggle}
                className={`relative w-10 h-6 rounded-full transition-colors disabled:opacity-40 shrink-0 mt-0.5 ${localConfig.encryptionEnabled && encReady ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'}`}
                aria-checked={localConfig.encryptionEnabled && encReady}
                role="switch"
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${localConfig.encryptionEnabled && encReady ? 'translate-x-4' : ''}`} />
              </button>
            </div>

            {/* Inline passphrase prompt for first-time setup */}
            {localConfig.encryptionEnabled && encReady && !rootKeyReady && showPassphraseInput && (
              <div>
                <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                  {t('integration.syncPassphrase')}
                </label>
                <input
                  type="password"
                  value={passphraseInput}
                  onChange={e => setPassphraseInput(e.target.value)}
                  placeholder={t('integration.syncPassphrasePlaceholder')}
                  autoComplete="current-password"
                  className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                />
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                  {t('integration.syncPassphraseHint')}
                </p>
              </div>
            )}

            {setupError && (
              <p className="text-xs text-red-500 dark:text-red-400">{setupError}</p>
            )}
          </div>

          {/* GLANCEvault intents (beta) — alternative transport to WebDAV above.
              Independent toggle; inherits its connection from Sync settings. */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              GLANCEvault intents (beta)
            </h3>
            <p className="text-xs text-amber-600 dark:text-amber-400">
              ⚠️ Experimental. Sends and receives intents over your GLANCEvault server instead of WebDAV. Requires the GLANCEvault connection set up in Sync settings.
            </p>
            <div className="flex items-center justify-between gap-3 py-1">
              <div className="min-w-0">
                <p className="text-sm text-slate-700 dark:text-slate-300">Intents via GLANCEvault</p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                  Database-backed delivery using your GLANCEvault connection. Your WebDAV intents config is left intact.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDbIntentsEnabled(v => !v)}
                className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${dbIntentsEnabled ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'}`}
                aria-checked={dbIntentsEnabled}
                role="switch"
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${dbIntentsEnabled ? 'translate-x-4' : ''}`} />
              </button>
            </div>

            {dbIntentsEnabled && (
              vaultConfigured ? (
                <p className="text-xs text-slate-400 dark:text-slate-500">
                  Using your GLANCEvault connection (URL, device token, account ID) from Sync settings. Saved on close; the app reloads to start polling.
                </p>
              ) : (
                <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40">
                  <p className="text-xs text-amber-700 dark:text-amber-300">
                    No GLANCEvault connection found. Set up the GLANCEvault server in Sync settings (URL, device token, account ID) first — until then this transport stays inactive.
                  </p>
                </div>
              )
            )}
          </div>

          {/* Activity log */}
          <div className="flex items-center justify-between py-1">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              {t('integration.activityLogSection')}
            </h3>
            <div className="flex items-center gap-3">
              {hasActivity && (
                <button
                  onClick={() => { clearActivityLog(); setHasActivity(false) }}
                  className="text-xs text-slate-400 dark:text-slate-500 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                >
                  {t('integration.clearLog')}
                </button>
              )}
              <button
                onClick={() => setShowActivityLog(true)}
                className="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
              >
                {t('integration.viewLog')}
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 border-t border-slate-100 dark:border-slate-700/40 shrink-0">
          <button
            onClick={onClose}
            disabled={saving}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 disabled:opacity-40 transition-colors"
          >
            {t('integration.cancel')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium text-green-400 border border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60 disabled:opacity-40 transition-colors"
          >
            {saving && <Loader size={14} className="animate-spin" />}
            {t('integration.save')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )

  return (
    <>
      {modal}
      {showActivityLog && <ActivityLogModal onClose={() => setShowActivityLog(false)} />}
      {showVaultPassphrase && (
        <PassphraseModal
          onSubmit={async (p) => {
            setShowVaultPassphrase(false)
            const resolve = vaultPassResolver.current
            vaultPassResolver.current = null
            resolve?.(p)
          }}
          onClose={() => {
            setShowVaultPassphrase(false)
            const resolve = vaultPassResolver.current
            vaultPassResolver.current = null
            resolve?.(null)
          }}
        />
      )}
    </>
  )
}
