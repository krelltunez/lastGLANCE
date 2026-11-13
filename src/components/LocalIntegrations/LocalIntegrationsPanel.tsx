import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ShieldCheck } from 'lucide-react'
import { useLocalIntegrations } from '@/hooks/useLocalIntegrations'
import type { DesktopMcpReadTier } from '@/native/desktop'
import {
  claudeCodeCommand, consentsForTier, maskToken, statusErrorKey, parsePortInput, tierAction, transitionErrorKey, writesAction,
  type ConsentKind,
} from '@/native/localIntegrations'
import { Description, Field, Segmented } from '@/components/SettingsPanel/controls'

// Settings → Integrations, desktop only: the Stream Deck listener and the MCP
// server (docs/mcp-and-stream-deck.md, section 3). Mounted only while
// LOCAL_INTEGRATIONS_UI is on. The consent flags are set in exactly one place,
// the consent dialog's Accept: every other path sends a change without them,
// and main refuses a change that needs one.

const button = 'shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300 border border-slate-200 dark:border-slate-600 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors'
const hint = 'mt-1.5 text-xs text-slate-400 dark:text-slate-500'
const code = 'flex-1 min-w-0 truncate bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-1.5 text-xs font-mono text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600'

interface PendingConsent {
  kinds: ConsentKind[]
  accept: () => void
}

export function LocalIntegrationsPanel() {
  const { t } = useTranslation()
  const { view, error, apply } = useLocalIntegrations()
  const [pending, setPending] = useState<PendingConsent | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState<'token' | 'command' | null>(null)
  const [portText, setPortText] = useState<string | null>(null)
  const [portInvalid, setPortInvalid] = useState(false)
  if (!view) return null
  const { mcp, streamDeck } = view

  const onOff = [
    { value: 'on' as const, label: t('settings.on') },
    { value: 'off' as const, label: t('settings.off') },
  ]

  const chooseTier = (tier: DesktopMcpReadTier) => {
    const kinds = consentsForTier(mcp.readTier, tier)
    if (kinds.length === 0) { void apply(tierAction(tier, [])); return }
    setPending({ kinds, accept: () => { void apply(tierAction(tier, kinds)) } })
  }

  const chooseWrites = (enabled: boolean) => {
    if (!enabled || mcp.writesEnabled) { void apply(writesAction(enabled, [])); return }
    setPending({ kinds: ['writes'], accept: () => { void apply(writesAction(true, ['writes'])) } })
  }

  const copy = (what: 'token' | 'command', text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(what)
      setTimeout(() => setCopied(null), 1500)
    }).catch(() => {})
  }

  const savePort = () => {
    const parsed = parsePortInput(portText ?? '')
    if (!parsed.ok) { setPortInvalid(true); return }
    setPortInvalid(false)
    void apply({ type: 'set-mcp-port', port: parsed.port }).then((ok) => { if (ok) setPortText(null) })
  }

  const status = (s: { running: boolean; error: string | null }, port: number) => (
    s.error
      ? <p className="mt-1.5 text-xs text-red-500 dark:text-red-400">{t(statusErrorKey(s.error), { port })}</p>
      : <p className={hint}>{s.running ? t('localIntegrations.statusRunning', { port }) : t('localIntegrations.statusStopped')}</p>
  )

  return (
    <div className="space-y-4 border-t border-slate-100 dark:border-slate-700/40 pt-4">
      <div>
        <div className="text-sm font-medium text-slate-700 dark:text-slate-200">{t('localIntegrations.title')}</div>
        <Description>{t('localIntegrations.intro')}</Description>
      </div>

      <Field label={t('localIntegrations.streamDeck')}>
        <Segmented<'on' | 'off'>
          label={t('localIntegrations.streamDeck')}
          value={streamDeck.enabled ? 'on' : 'off'}
          onChange={v => { void apply({ type: 'set-stream-deck', enabled: v === 'on' }) }}
          options={onOff}
        />
        <p className={hint}>{t('localIntegrations.streamDeckHint', { port: streamDeck.port })}</p>
        {streamDeck.enabled && status(streamDeck.status, streamDeck.port)}
      </Field>

      <Field label={t('localIntegrations.mcp')}>
        <Segmented<DesktopMcpReadTier>
          label={t('localIntegrations.mcp')}
          value={mcp.readTier}
          onChange={chooseTier}
          options={[
            { value: 'off', label: t('settings.off') },
            { value: 'chores', label: t('localIntegrations.tierChores') },
            { value: 'chores_people', label: t('localIntegrations.tierChoresPeople') },
          ]}
        />
        <p className={hint}>{t('localIntegrations.mcpHint')}</p>
        {mcp.readTier !== 'off' && status(mcp.status, mcp.port)}
      </Field>

      {mcp.readTier !== 'off' && (
        <>
          <Field label={t('localIntegrations.writes')}>
            <Segmented<'on' | 'off'>
              label={t('localIntegrations.writes')}
              value={mcp.writesEnabled ? 'on' : 'off'}
              onChange={v => chooseWrites(v === 'on')}
              options={onOff}
            />
            <p className={hint}>{t('localIntegrations.writesHint')}</p>
          </Field>

          {mcp.token && (
            <Field label={t('localIntegrations.token')}>
              <div className="flex items-center gap-2">
                <code className={code}>{revealed ? mcp.token : maskToken(mcp.token)}</code>
                <button type="button" className={button} onClick={() => setRevealed(r => !r)}>
                  {revealed ? t('localIntegrations.hide') : t('localIntegrations.show')}
                </button>
                <button type="button" className={button} onClick={() => copy('token', mcp.token!)}>
                  {copied === 'token' ? t('localIntegrations.copied') : t('localIntegrations.copy')}
                </button>
                <button type="button" className={button} onClick={() => { void apply({ type: 'rotate-token' }) }}>
                  {t('localIntegrations.rotate')}
                </button>
              </div>
              <p className={hint}>{t('localIntegrations.tokenHint')}</p>
            </Field>
          )}

          <Field label={t('localIntegrations.address')} htmlFor="local-integrations-port">
            <div className="flex items-center gap-2">
              <code className={code}>{mcp.endpoint}</code>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <input
                id="local-integrations-port"
                inputMode="numeric"
                value={portText ?? (mcp.portOverride === null ? '' : String(mcp.portOverride))}
                placeholder={String(mcp.port)}
                onChange={e => { setPortText(e.target.value); setPortInvalid(false) }}
                onKeyDown={e => { if (e.key === 'Enter') savePort() }}
                aria-label={t('localIntegrations.port')}
                className="w-28 bg-slate-100 dark:bg-slate-700 rounded-lg px-3 py-1.5 text-sm font-mono text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-600 focus:outline-none focus:ring-2 focus:ring-green-400"
              />
              {portText !== null && (
                <button type="button" className={button} onClick={savePort}>{t('localIntegrations.save')}</button>
              )}
            </div>
            <p className={hint}>{t('localIntegrations.portHint')}</p>
            {portInvalid && <p className="mt-1 text-xs text-red-500 dark:text-red-400">{t('localIntegrations.errorInvalidPort')}</p>}
          </Field>

          {mcp.token && (
            <Field label={t('localIntegrations.claudeCode')}>
              <div className="flex items-center gap-2">
                <code className={code}>{claudeCodeCommand(mcp.endpoint, revealed ? mcp.token : maskToken(mcp.token))}</code>
                <button type="button" className={button} onClick={() => copy('command', claudeCodeCommand(mcp.endpoint, mcp.token!))}>
                  {copied === 'command' ? t('localIntegrations.copied') : t('localIntegrations.copy')}
                </button>
              </div>
              <p className={hint}>{t('localIntegrations.claudeCodeHint')}</p>
            </Field>
          )}
        </>
      )}

      {error && <p className="text-xs text-red-500 dark:text-red-400">{t(transitionErrorKey(error))}</p>}

      {pending && (
        <ConsentDialog
          kinds={pending.kinds}
          onAccept={() => { const p = pending; setPending(null); p.accept() }}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  )
}

function ConsentDialog({ kinds, onAccept, onCancel }: { kinds: ConsentKind[]; onAccept: () => void; onCancel: () => void }) {
  const { t } = useTranslation()
  const text: Record<ConsentKind, string> = {
    base: t('localIntegrations.consentBase'),
    people: t('localIntegrations.consentPeople'),
    writes: t('localIntegrations.consentWrites'),
  }
  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center app-safe-bottom bg-black/40 dark:bg-black/60 backdrop-blur-sm">
      <div role="dialog" aria-modal="true" aria-labelledby="local-integrations-consent-title" className="w-full sm:max-w-sm flex flex-col bg-white dark:bg-slate-800 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-700/50">
        <div className="px-6 pt-6 pb-2 space-y-2">
          <div className="flex items-center gap-2">
            <ShieldCheck size={16} className="text-green-400 shrink-0" />
            <h2 id="local-integrations-consent-title" className="text-sm font-semibold text-slate-800 dark:text-slate-200">{t('localIntegrations.consentTitle')}</h2>
          </div>
          {kinds.map(k => <p key={k} className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">{text[k]}</p>)}
        </div>
        <div className="flex gap-2 px-6 pt-3 pb-6">
          <button onClick={onCancel} className="flex-1 py-2.5 rounded-xl text-sm font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors">
            {t('localIntegrations.cancel')}
          </button>
          <button onClick={onAccept} className="flex-1 py-2.5 rounded-xl text-sm font-medium text-white bg-green-500 hover:bg-green-400 transition-colors">
            {t('localIntegrations.accept')}
          </button>
        </div>
      </div>
    </div>
  )
}
