import type { DesktopIntegrationsAction, DesktopMcpReadTier } from './desktop'

// The Settings panel's decisions for the local integrations
// (docs/mcp-and-stream-deck.md, section 3), pure so they are tested without a
// DOM: which consent a change needs, the action it sends once accepted, the
// port field, and which message a failure shows. Main decides again
// (electron/localIntegrations.ts, applyTransition): this only keeps the panel
// from sending what main would refuse, and says why.

/** Whether the panel is mounted. Off until the phase that ships it (section 2). */
export const LOCAL_INTEGRATIONS_UI = false

export type ConsentKind = 'base' | 'people' | 'writes'

/** The consents a read-tier change needs, in the order the dialog shows them. */
export function consentsForTier(current: DesktopMcpReadTier, target: DesktopMcpReadTier): ConsentKind[] {
  if (target === 'off' || target === current) return []
  const needed: ConsentKind[] = []
  if (current === 'off') needed.push('base')
  if (target === 'chores_people') needed.push('people')
  return needed
}

/** The transition for a tier change, carrying exactly the consents accepted. */
export function tierAction(target: DesktopMcpReadTier, accepted: readonly ConsentKind[]): DesktopIntegrationsAction {
  return {
    type: 'set-mcp-read-tier',
    tier: target,
    ...(accepted.includes('base') && { consentConfirmed: true }),
    ...(accepted.includes('people') && { peopleConsentConfirmed: true }),
  }
}

/** The transition for the "Allow changes" switch; turning it on needs its consent. */
export function writesAction(enabled: boolean, accepted: readonly ConsentKind[]): DesktopIntegrationsAction {
  return { type: 'set-mcp-writes', enabled, ...(enabled && accepted.includes('writes') && { writesConsentConfirmed: true }) }
}

/** The port field: empty is the default, a whole number in range is an override, anything else is refused. */
export function parsePortInput(text: string): { ok: true; port: number | null } | { ok: false } {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: true, port: null }
  if (!/^\d{1,5}$/.test(trimmed)) return { ok: false }
  const port = Number(trimmed)
  return port >= 1 && port <= 65535 ? { ok: true, port } : { ok: false }
}

/** The token as shown until revealed: its first and last four characters. */
export function maskToken(token: string): string {
  return token.length <= 8 ? '•'.repeat(token.length) : `${token.slice(0, 4)}${'•'.repeat(8)}${token.slice(-4)}`
}

/** The Claude Code command that connects to this server. */
export function claudeCodeCommand(endpoint: string, token: string): string {
  return `claude mcp add --transport http lastglance ${endpoint} --header "Authorization: Bearer ${token}"`
}

/** The translation key for a refused transition. */
export function transitionErrorKey(error: string): string {
  switch (error) {
    case 'invalid_port': return 'localIntegrations.errorInvalidPort'
    case 'port_reserved': return 'localIntegrations.errorPortReserved'
    default: return 'localIntegrations.errorGeneric'
  }
}
