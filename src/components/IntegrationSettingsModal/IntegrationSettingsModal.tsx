import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader } from 'lucide-react'
import { hasEncryptionReady, getSyncPassphrase } from '@glance-apps/sync'
import {
  type IntentsConfig,
  DEFAULT_CONFIG,
  saveIntentsConfig,
} from '@/intents/config'
import { ActivityLogModal } from '@/components/ActivityLogModal/ActivityLogModal'
import { testConnection } from '@/intents/webdav'
import { loadIntentsRootKey, clearIntentsRootKey } from '@/intents/intentsKeyStore'
import { setupIntentsEncryption } from '@/intents/setupIntentsEncryption'
import { useEscapeKey } from '@/hooks/useEscapeKey'

interface Props {
  onClose: () => void
  onSaved: () => void
}

type TestStatus = 'idle' | 'testing' | 'ok' | 'fail'

interface LocalConfig extends IntentsConfig {}

export function IntegrationSettingsModal({ onClose, onSaved }: Props) {
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
  const [rootKeyReady, setRootKeyReady] = useState<boolean | null>(null)
  const [showPassphraseInput, setShowPassphraseInput] = useState(false)
  const [passphraseInput, setPassphraseInput] = useState('')
  const [setupError, setSetupError] = useState('')
  const [saving, setSaving] = useState(false)

  const encReady = hasEncryptionReady()

  useEffect(() => {
    loadIntentsRootKey().then(key => setRootKeyReady(key !== null))
  }, [])

  useEscapeKey(showActivityLog ? () => {} : onClose)

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
        setTestError(result.error ?? 'Connection failed')
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
      if (localConfig.encryptionEnabled && !rootKeyReady) {
        const passphrase = getSyncPassphrase() ?? passphraseInput.trim()
        if (!passphrase) {
          setSetupError('Enter your sync passphrase to complete setup')
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
      onSaved()
      onClose()
    } catch (err) {
      setSetupError(err instanceof Error ? err.message : 'Setup failed')
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
            dayGLANCE Integration
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
              Connection
            </h3>

            {/* Enable toggle */}
            <div className="flex items-center justify-between py-1">
              <span className="text-sm text-slate-700 dark:text-slate-300">Enable integration</span>
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
                WebDAV URL
              </label>
              <input
                type="url"
                value={localConfig.webdavUrl}
                onChange={e => set('webdavUrl', e.target.value)}
                placeholder="https://your-server.com/remote.php/dav/files/user/"
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                Nextcloud: <span className="font-mono">https://your-server/remote.php/dav/files/username/</span>
              </p>
            </div>

            {/* Username */}
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                Username
              </label>
              <input
                type="text"
                value={localConfig.webdavUsername}
                onChange={e => set('webdavUsername', e.target.value)}
                placeholder="your-username"
                autoComplete="username"
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
            </div>

            {/* Password */}
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                Password
              </label>
              <input
                type="password"
                value={localConfig.webdavPassword}
                onChange={e => set('webdavPassword', e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
            </div>

            {/* Folder path */}
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                Folder path
              </label>
              <input
                type="text"
                value={localConfig.folderPath}
                onChange={e => set('folderPath', e.target.value)}
                placeholder="GLANCE/events"
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
                Test connection
              </button>
              {testStatus === 'ok' && (
                <span className="text-xs text-green-500 dark:text-green-400">Connected</span>
              )}
              {testStatus === 'fail' && (
                <span className="text-xs text-red-500 dark:text-red-400">{testError || 'Connection failed'}</span>
              )}
            </div>
          </div>

          {/* Polling section */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Polling
            </h3>
            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                Poll interval (minutes)
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
              Encryption
            </h3>
            <div className="flex items-start justify-between py-1">
              <div>
                <p className={`text-sm ${encReady ? 'text-slate-700 dark:text-slate-300' : 'text-slate-400 dark:text-slate-500'}`}>
                  Encrypt intent files
                </p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                  {encReady
                    ? rootKeyReady
                      ? 'Encryption active. Set up once; remains active across sessions.'
                      : 'Uses your cloud sync passphrase. Set up once; remains active across sessions.'
                    : 'Requires cloud sync encryption to be enabled first'}
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
                  Sync passphrase
                </label>
                <input
                  type="password"
                  value={passphraseInput}
                  onChange={e => setPassphraseInput(e.target.value)}
                  placeholder="Enter your sync passphrase"
                  autoComplete="current-password"
                  className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                />
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-1">
                  Used once to set up encryption. Not stored after save.
                </p>
              </div>
            )}

            {setupError && (
              <p className="text-xs text-red-500 dark:text-red-400">{setupError}</p>
            )}
          </div>

          {/* Activity log */}
          <div className="flex items-center justify-between py-1">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Activity Log
            </h3>
            <button
              onClick={() => setShowActivityLog(true)}
              className="text-xs text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
            >
              View log →
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-3 px-6 py-4 border-t border-slate-100 dark:border-slate-700/40 shrink-0">
          <button
            onClick={onClose}
            disabled={saving}
            className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 disabled:opacity-40 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium text-green-400 border border-green-400/40 hover:text-green-300 hover:bg-green-400/10 hover:border-green-400/60 disabled:opacity-40 transition-colors"
          >
            {saving && <Loader size={14} className="animate-spin" />}
            Save
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
    </>
  )
}
