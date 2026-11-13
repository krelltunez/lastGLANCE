import { useTranslation } from 'react-i18next'
import type { DesktopAssistantIndicator } from '@/native/desktop'
import { assistantLabelKey } from '@/native/localIntegrations'

// The assistant indicator (docs/mcp-and-stream-deck.md, 4.6), decided in main
// (electron/localIntegrations.ts, assistantIndicator): green while the MCP
// server runs, blue while there are assistant changes to undo, red while
// changes are paused. Nothing when it is off. With onClick it is a labelled
// button (the tray popup's, which opens Settings at Integrations); without, it
// is decorative beside its words (Settings).

const COLOR: Record<Exclude<DesktopAssistantIndicator, 'off'>, string> = {
  on: 'bg-green-500',
  undo: 'bg-blue-500',
  paused: 'bg-red-500',
}

export function AssistantDot({ indicator, onClick }: { indicator: DesktopAssistantIndicator | undefined; onClick?: () => void }) {
  const { t } = useTranslation()
  const key = assistantLabelKey(indicator)
  if (!key || !indicator || indicator === 'off') return null
  const color = COLOR[indicator]
  const label = t(key)
  const dot = <span aria-hidden className={`block w-2 h-2 rounded-full ${color} ring-2 ring-white/70 dark:ring-slate-900/70`} />
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      data-assistant-indicator={indicator}
      className="shrink-0 p-1.5 -m-1.5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-green-400/60"
    >
      {dot}
    </button>
  ) : (
    <span data-assistant-indicator={indicator} className="inline-flex shrink-0">{dot}</span>
  )
}
