import { useTranslation } from 'react-i18next'
import { Loader, Network } from 'lucide-react'
import type { DesktopHttpGrant } from '@/native/desktop'

// The desktop app's private-address permission in Cloud Sync
// (src/sync/privateAddress.ts has the flow). Renders nothing off the desktop.

/** "Allow this address…", under a connection test the desktop refused. */
export function AllowAddressButton({ onClick, busy }: { onClick: () => void; busy: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-1">
      <button
        onClick={onClick}
        disabled={busy}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-amber-300 dark:border-amber-600/60 text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-900/20 disabled:opacity-40 transition-colors"
      >
        {busy ? <Loader size={12} className="animate-spin" /> : <Network size={12} />}
        {t('sync.privateAddress.allow')}
      </button>
      <p className="text-xs text-slate-400 dark:text-slate-500">{t('sync.privateAddress.allowHint')}</p>
    </div>
  )
}

export function AllowedAddresses({ grants, onRemove }: { grants: DesktopHttpGrant[]; onRemove: (origin: string) => void }) {
  const { t } = useTranslation()
  if (grants.length === 0) return null
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {t('sync.privateAddress.allowedTitle')}
      </h3>
      <ul className="space-y-1.5">
        {grants.map(grant => (
          <li key={grant.origin} className="flex items-center justify-between gap-3 rounded-lg bg-slate-100 dark:bg-slate-700/60 px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm text-slate-800 dark:text-slate-100 truncate">{grant.origin}</p>
              <p className="text-xs text-slate-400 dark:text-slate-500 truncate">{grant.addresses.join(', ')}</p>
            </div>
            <button
              onClick={() => onRemove(grant.origin)}
              className="shrink-0 px-2.5 py-1 rounded-lg text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
            >
              {t('sync.privateAddress.remove')}
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
