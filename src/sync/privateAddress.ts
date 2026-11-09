import type { TFunction } from 'i18next'
import { desktopBridge, type DesktopHttp } from '@/native/desktop'

// The desktop app's private-address permission, as Cloud Sync sees it
// (docs/desktop-app.md, section 4, LAN servers). The main process refuses a
// server on a private network until the user grants its exact origin, and a
// refused request never reaches the server. So a connection test asks first,
// and says "needs your permission" with an Allow button, rather than reporting
// a network error for a server it never contacted. Off the desktop there is no
// such rule (the phones and the web reach a LAN server directly) and every
// helper here is a no-op. After dayGLANCE's src/sync/proxyTrustPreflight.js.

export interface PrivateAddressBlock {
  origin: string
  /** False for addresses no grant can unlock (link-local, reserved ranges). */
  canGrant: boolean
}

type Http = Pick<DesktopHttp, 'inspect' | 'grant'>

const defaultHttp = (): Http | null => desktopBridge()?.http ?? null

/**
 * Whether the desktop will refuse `url`, before anything is sent. Null when it
 * will go through, off the desktop, or when the check itself fails: it is a
 * diagnostic, never a gate, and the real request reports whatever happens next.
 */
export async function checkPrivateAddress(url: string | null | undefined, http: Http | null = defaultHttp()): Promise<PrivateAddressBlock | null> {
  if (!http || !url) return null
  try {
    const verdict = await http.inspect(url)
    return verdict.blocked ? { origin: verdict.origin, canGrant: verdict.canGrant } : null
  } catch {
    return null
  }
}

/** The server URL a WebDAV provider's form holds: its `url` field. Koofr has none. */
export function providerServerUrl(
  fields: ReadonlyArray<{ key: string; type?: string }> | undefined,
  values: Record<string, string>,
): string | null {
  const field = fields?.find(f => f.type === 'url')
  const value = field ? (values[field.key] ?? '').trim() : ''
  return value || null
}

/** The message a blocked connection test shows. */
export function blockedMessage(t: TFunction, block: PrivateAddressBlock): string {
  return t(block.canGrant ? 'sync.privateAddress.needsPermission' : 'sync.privateAddress.refused', { origin: block.origin })
}

/**
 * The permission dialog's text. The main process has no locale bundle, so the
 * translated chrome travels with the request; the origin and the addresses it
 * resolves to are added by the main process, where no label can hide them.
 * `kind` picks the warning for a server on this same computer.
 */
export function consentLabels(t: TFunction, kind: 'vault' | 'server'): Record<string, string> {
  return {
    title: t('sync.privateAddress.consentTitle'),
    question: t('sync.privateAddress.consentQuestion'),
    resolvesTo: t('sync.privateAddress.consentResolvesTo'),
    warning: t('sync.privateAddress.consentWarning'),
    warningLoopback: t(kind === 'vault' ? 'sync.privateAddress.consentWarningLoopbackVault' : 'sync.privateAddress.consentWarningLoopbackServer'),
    scope: t('sync.privateAddress.consentScope'),
    allow: t('sync.privateAddress.consentAllow'),
    cancel: t('sync.privateAddress.consentCancel'),
  }
}

/**
 * Show the permission dialog for `url`. Null once the origin is granted, else
 * the message to show (the user declined, or the address cannot be granted).
 */
export async function grantPrivateAddress(t: TFunction, url: string, kind: 'vault' | 'server', http: Http | null = defaultHttp()): Promise<string | null> {
  if (!http) return t('sync.privateAddress.grantFailed')
  try {
    const result = await http.grant(url, consentLabels(t, kind))
    return result.ok ? null : result.reason || t('sync.privateAddress.grantFailed')
  } catch {
    return t('sync.privateAddress.grantFailed')
  }
}
