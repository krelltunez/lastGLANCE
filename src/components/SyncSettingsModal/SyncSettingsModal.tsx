import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader, AlertTriangle } from 'lucide-react'
import type { SyncEngine } from '@glance-apps/sync'
import { setupEncryptionKey, clearEncryptionKey, CRYPTO_CONFIG } from '@/sync/engine'
import { useEscapeKey } from '@/hooks/useEscapeKey'

interface Props {
  engine: SyncEngine | null
  onClose: () => void
}

type TestStatus = 'idle' | 'testing' | 'ok' | 'fail'

export function SyncSettingsModal({ engine, onClose }: Props) {
  const existingConfig = engine?.getConfig() ?? null

  const [url, setUrl] = useState(() => (existingConfig?.url as string) ?? '')
  const [username, setUsername] = useState(() => (existingConfig?.username as string) ?? '')
  const [password, setPassword] = useState(() => (existingConfig?.password as string) ?? '')

  const [testStatus, setTestStatus] = useState<TestStatus>('idle')
  const [testError, setTestError] = useState('')

  const [encEnabled, setEncEnabled] = useState(() => engine?.hasEncryptionReady() ?? false)
  const [passphrase, setPassphrase] = useState('')
  const [showPassphraseInput, setShowPassphraseInput] = useState(false)
  const [encSaving, setEncSaving] = useState(false)
  const [encError, setEncError] = useState('')

  const [syncing, setSyncing] = useState(false)

  const halted = engine?.isHardStopped() ?? false

  useEscapeKey(onClose)

  function handleSaveConnection() {
    if (!engine) return
    engine.setConfig(url ? { url, username, password } : null)
  }

  async function handleTest() {
    if (!engine || !url) return
    setTestStatus('testing')
    setTestError('')
    try {
      const result = await engine.test({ url, username, password })
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

  async function handleEnableEncryption() {
    if (!passphrase.trim()) return
    setEncSaving(true)
    setEncError('')
    try {
      await setupEncryptionKey(passphrase.trim(), CRYPTO_CONFIG)
      setEncEnabled(true)
      setShowPassphraseInput(false)
      setPassphrase('')
    } catch (err) {
      setEncError(err instanceof Error ? err.message : 'Failed to set passphrase')
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
    } catch (err) {
      setEncError(err instanceof Error ? err.message : 'Failed to clear encryption key')
    } finally {
      setEncSaving(false)
    }
  }

  async function handleSyncNow() {
    if (!engine) return
    setSyncing(true)
    try {
      await engine.sync()
    } finally {
      setSyncing(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-md bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/50 flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 shrink-0">
          <h2 className="text-base font-semibold text-slate-800 dark:text-slate-100">Cloud Sync</h2>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable body */}
        <div className="overflow-y-auto flex-1 px-6 pb-4 space-y-5">

          {/* Hard stop warning */}
          {halted && (
            <div className="flex items-start gap-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/40">
              <AlertTriangle size={16} className="text-amber-500 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-amber-700 dark:text-amber-300 font-medium">Sync halted</p>
                <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                  A critical error occurred. Resolve the issue and clear to retry.
                </p>
              </div>
              <button
                onClick={() => { engine?.clearHardStop() }}
                className="text-xs text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-200 font-medium shrink-0 underline"
              >
                Clear
              </button>
            </div>
          )}

          {/* Connection section */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              WebDAV Connection
            </h3>

            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                Server URL
              </label>
              <input
                type="url"
                value={url}
                onChange={e => setUrl(e.target.value)}
                placeholder="https://your-server.com/remote.php/dav/files/user/"
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                placeholder="your-username"
                autoComplete="username"
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-500 dark:text-slate-400 mb-1">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
            </div>

            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={handleSaveConnection}
                disabled={!engine}
                className="px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 transition-colors"
              >
                Save
              </button>
              <button
                onClick={handleTest}
                disabled={testStatus === 'testing' || !url}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 transition-colors"
              >
                {testStatus === 'testing' && <Loader size={12} className="animate-spin" />}
                Test connection
              </button>
              {testStatus === 'ok' && (
                <span className="text-xs text-green-500 dark:text-green-400">Connected</span>
              )}
              {testStatus === 'fail' && (
                <span className="text-xs text-red-500 dark:text-red-400">{testError || 'Failed'}</span>
              )}
            </div>
          </div>

          {/* Encryption section */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Encryption
            </h3>

            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm text-slate-700 dark:text-slate-300">Encrypt sync data</p>
                <p className="text-xs text-slate-400 dark:text-slate-500 mt-0.5">
                  {encEnabled ? 'Encryption is active' : 'Data is stored unencrypted'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (encEnabled) {
                    handleDisableEncryption()
                  } else {
                    setShowPassphraseInput(p => !p)
                  }
                }}
                disabled={encSaving}
                className={`relative w-10 h-6 rounded-full transition-colors disabled:opacity-40 ${encEnabled ? 'bg-green-400' : 'bg-slate-300 dark:bg-slate-600'}`}
                aria-checked={encEnabled}
                role="switch"
              >
                <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${encEnabled ? 'translate-x-4' : ''}`} />
              </button>
            </div>

            {showPassphraseInput && !encEnabled && (
              <div className="space-y-2">
                <input
                  type="password"
                  value={passphrase}
                  onChange={e => setPassphrase(e.target.value)}
                  placeholder="Enter passphrase"
                  autoComplete="new-password"
                  onKeyDown={e => { if (e.key === 'Enter') handleEnableEncryption() }}
                  className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
                />
                <button
                  onClick={handleEnableEncryption}
                  disabled={!passphrase.trim() || encSaving}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-green-400 text-white hover:bg-green-300 disabled:opacity-40 transition-colors"
                >
                  {encSaving && <Loader size={12} className="animate-spin" />}
                  Set passphrase
                </button>
              </div>
            )}

            {encError && (
              <p className="text-xs text-red-500 dark:text-red-400">{encError}</p>
            )}
          </div>

          {/* Manual sync section */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide">
              Manual Sync
            </h3>
            <button
              onClick={handleSyncNow}
              disabled={!engine || syncing || engine.isSyncing()}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium border border-slate-200 dark:border-slate-600 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 transition-colors"
            >
              {syncing && <Loader size={14} className="animate-spin" />}
              Sync now
            </button>
          </div>

        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-700/40 shrink-0">
          <button
            onClick={onClose}
            className="w-full py-2.5 rounded-xl text-sm font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
