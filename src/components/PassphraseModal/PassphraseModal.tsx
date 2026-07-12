import { useState } from 'react'
import { createPortal } from 'react-dom'
import { X, Loader, ShieldAlert } from 'lucide-react'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from 'react-i18next'
import { isWebCryptoAvailable } from '@/utils/secureContext'

interface Props {
  onSubmit: (passphrase: string) => Promise<void>
  onClose: () => void
}

export function PassphraseModal({ onSubmit, onClose }: Props) {
  const { t } = useTranslation()
  const [passphrase, setPassphrase] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  // Deriving the key needs Web Crypto (crypto.subtle), which is only exposed in a
  // secure context. Detect its absence so we explain it rather than throwing a
  // cryptic "reading 'importKey'" error when the user submits.
  const cryptoAvailable = isWebCryptoAvailable()

  useEscapeKey(onClose)

  async function handleSubmit() {
    if (!cryptoAvailable) return
    if (!passphrase.trim()) return
    setSubmitting(true)
    setError('')
    try {
      await onSubmit(passphrase.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : t('passphrase.failedToUnlock'))
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center app-safe-bottom bg-black/40 dark:bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="w-full sm:max-w-sm bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl border border-slate-200 dark:border-slate-700/50">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">{t('passphrase.title')}</h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {cryptoAvailable ? (
          <>
            <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
              {t('passphrase.description')}
            </p>

            <div className="space-y-3">
              <input
                type="password"
                value={passphrase}
                onChange={e => setPassphrase(e.target.value)}
                placeholder={t('passphrase.placeholder')}
                autoComplete="current-password"
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
                className="w-full bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-2 text-sm text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />

              {error && (
                <p className="text-xs text-red-500 dark:text-red-400">{error}</p>
              )}

              <button
                onClick={handleSubmit}
                disabled={!passphrase.trim() || submitting}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium text-white bg-green-500 hover:bg-green-400 disabled:opacity-50 transition-colors"
              >
                {submitting && <Loader size={14} className="animate-spin" />}
                {t('passphrase.unlock')}
              </button>
            </div>
          </>
        ) : (
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 p-3">
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-500 dark:text-amber-400" />
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {t('passphrase.insecureContext')}
            </p>
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
