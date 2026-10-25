// GLANCEintents over iCloud (docs/icloud-sync.md), dayGLANCE's iCloud intents
// tier (src/intents/icloudFileTransport.js, icloudIntentsConfig.js and the
// iCloud halves of useIntentPoller.js and deliverers.js), so the two apps
// exchange intents on an iPhone or iPad with nothing but iCloud.
//
//   • The folder is dayGLANCE's: GLANCE/events/ in the iCloud.com.dayglance
//     container, one file per event named by the package's filenameFor, the
//     layout the WebDAV tier uses. Both apps' App IDs carry that container.
//   • Opt-in, off by default, like every other intents transport: without the
//     flag nothing is sent to or read from iCloud, which is what keeps the
//     "intents are opt-in" privacy statement true.
//   • Always plaintext. iCloud Drive is encrypted by Apple at rest and in
//     transit, and dayGLANCE's iCloud poll refuses an encrypted envelope as a
//     misconfigured sender, so this one does too.

import { buildEnvelope, filenameFor, parseEnvelope, parseFilename, ACTIONS, type CreatePayload, type Envelope } from '@glance-apps/intents'
import { icloudBridge, type ICloudBridge } from '@/native/icloud'
import { CURSOR_LOOKBACK_MS, cursorLookback } from './pollCursor'
import type { Deliverer, DeliveryResult, OutboxIntent } from './outbox'

export const ICLOUD_INTENTS_ENABLED_KEY = 'lg_icloud_intents_enabled'
export const ICLOUD_INTENTS_CURSOR_KEY = 'lg_icloud_intents_cursor'
/** dayGLANCE's DEFAULT_EVENTS_PATH, relative to the container's Documents/. */
export const ICLOUD_EVENTS_PATH = 'GLANCE/events/'
/** dayGLANCE's foreground cadence for its iCloud poll. */
export const ICLOUD_INTENTS_POLL_MS = 2 * 60 * 1000

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null
const defaultStorage = (): StorageLike => (typeof localStorage === 'undefined' ? null : localStorage)

/** The raw opt-in flag. */
export function getICloudIntentsEnabledFlag(storage: StorageLike = defaultStorage()): boolean {
  try { return storage?.getItem(ICLOUD_INTENTS_ENABLED_KEY) === 'true' } catch { return false }
}

/** Persist the opt-in flag. Removes the key when disabling. */
export function setICloudIntentsEnabled(enabled: boolean, storage: StorageLike = defaultStorage()): void {
  try {
    if (enabled) storage?.setItem(ICLOUD_INTENTS_ENABLED_KEY, 'true')
    else storage?.removeItem(ICLOUD_INTENTS_ENABLED_KEY)
  } catch { /* private mode / quota */ }
}

/** True only on iOS with the plugin AND the user's opt-in; the emit target and the poll both check it. */
export function isICloudIntentsEnabled(bridge: () => ICloudBridge | null = icloudBridge): boolean {
  return !!bridge() && getICloudIntentsEnabledFlag()
}

// ── Deliverer ────────────────────────────────────────────────────────────────

export interface ICloudDelivererDeps {
  bridge: () => ICloudBridge | null
  enabled: () => boolean
}

export function createICloudDeliverer(deps: ICloudDelivererDeps): Deliverer {
  return async (intent: OutboxIntent): Promise<DeliveryResult> => {
    const b = deps.bridge()
    // Off, or iCloud away (signed out, iCloud Drive off): both may change, so hold.
    if (!b || !deps.enabled() || !(await b.available())) return 'transient-fail'
    const envelope = buildEnvelope({
      action: ACTIONS.CREATE,
      payload: intent.payload as CreatePayload,
      emittedBy: intent.emitted_by,
      eventId: intent.event_id,
      ...(intent.emitted_at ? { emittedAt: new Date(intent.emitted_at) } : {}),
    })
    // The package's name, which dayGLANCE's iCloud deliverer and poll use too.
    const path = ICLOUD_EVENTS_PATH + filenameFor(envelope)
    const body = JSON.stringify(envelope)
    let ok = await b.write(path, body, { container: 'dayglance' })
    if (!ok) {
      // The folder may not exist yet on a first send.
      await b.makeDir(ICLOUD_EVENTS_PATH, 'dayglance')
      ok = await b.write(path, body, { container: 'dayglance' })
    }
    return ok ? 'delivered' : 'transient-fail'
  }
}

export const icloudDeliverer: Deliverer = createICloudDeliverer({ bridge: icloudBridge, enabled: () => getICloudIntentsEnabledFlag() })

// ── Poll ─────────────────────────────────────────────────────────────────────

export interface ICloudPollDeps {
  bridge: () => ICloudBridge | null
  storage?: StorageLike
  process: (envelope: Envelope) => Promise<void>
  addActivityEntry: (entry: { type: 'received' | 'error' | 'warning' | 'sent'; message: string; detail?: string }) => void
}

/**
 * One poll of the shared events folder: every event file newer than this
 * transport's cursor (less the look-back), in order. A file still downloading
 * stops the pass with the cursor in place, so it is read on a later poll; an
 * unreadable, encrypted or malformed one is noted and passed over.
 */
export async function pollICloudIntents(deps: ICloudPollDeps): Promise<void> {
  const b = deps.bridge()
  if (!b) return
  const storage = deps.storage ?? defaultStorage()
  const names = await b.list(ICLOUD_EVENTS_PATH, 'dayglance')
  if (!names) return   // iCloud away: try again next poll

  const cursor = (() => { try { return storage?.getItem(ICLOUD_INTENTS_CURSOR_KEY) ?? null } catch { return null } })()
  const effective = cursor ? cursorLookback(cursor, CURSOR_LOOKBACK_MS) : null
  const files = names
    .map((filename) => ({ filename, parsed: parseFilename(filename) }))
    .filter((f): f is { filename: string; parsed: NonNullable<ReturnType<typeof parseFilename>> } => f.parsed !== null && (!effective || f.parsed.timestamp > effective))
    .sort((a, b2) => a.parsed.timestamp.localeCompare(b2.parsed.timestamp))

  let next = cursor
  for (const { filename, parsed } of files) {
    const r = await b.read(ICLOUD_EVENTS_PATH + filename, { container: 'dayglance' })
    if (r.kind === 'downloading') break
    if (r.kind !== 'text') {
      if (r.kind === 'error') deps.addActivityEntry({ type: 'error', message: `Failed to read iCloud intent file ${filename}`, detail: r.error })
      next = parsed.timestamp
      continue
    }
    let data: unknown
    try { data = JSON.parse(r.text ?? '') } catch { next = parsed.timestamp; continue }
    if (data && typeof data === 'object' && (data as Record<string, unknown>).encrypted === true) {
      deps.addActivityEntry({ type: 'warning', message: 'Skipped an encrypted intent on iCloud (iCloud intents are always plain)', detail: filename })
      next = parsed.timestamp
      continue
    }
    let envelope: Envelope
    try { envelope = parseEnvelope(data) } catch { next = parsed.timestamp; continue }
    await deps.process(envelope)
    next = parsed.timestamp
  }
  if (next && next !== cursor) {
    try { storage?.setItem(ICLOUD_INTENTS_CURSOR_KEY, next) } catch { /* the look-back covers a lost write */ }
  }
}
