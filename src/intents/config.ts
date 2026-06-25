export interface IntentsConfig {
  enabled: boolean
  webdavUrl: string
  webdavUsername: string
  webdavPassword: string
  folderPath: string
  pollIntervalMinutes: number
  encryptionEnabled: boolean
}

// Delivery lifecycle of an OUTBOUND intent, surfaced as a chip on its Activity
// Log entry. Forward-only: queued -> held -> delivered, never backwards.
//   queued    — enqueued durably; a transmit has not yet succeeded.
//   held      — a transmit attempt is holding (today: the vault intents key is
//               not cached on this device yet), so nothing has gone out.
//   delivered — the row reached the GLANCEvault relay (the POST returned 2xx).
//               This is NOT a peer-receipt: GLANCEvault is a zero-knowledge,
//               insert-only relay with no end-to-end acknowledgement, so "the
//               peer app ingested it" is explicitly NOT claimed here.
export type IntentDelivery = 'queued' | 'held' | 'delivered'

export interface ActivityEntry {
  id: string
  timestamp: string
  type: 'sent' | 'received' | 'warning' | 'error'
  message: string
  detail?: string
  // OUTBOUND-only observability fields. `direction: 'out'` marks an entry the
  // delivery reconcile may update; `eventId` is the intent's stable id (the
  // outbox key) used to match a flush outcome back to its entry; `delivery` is
  // the lifecycle state above.
  direction?: 'out' | 'in'
  eventId?: string
  delivery?: IntentDelivery
}

export const DEFAULT_CONFIG: IntentsConfig = {
  enabled: false,
  webdavUrl: '',
  webdavUsername: '',
  webdavPassword: '',
  folderPath: 'GLANCE/events',
  pollIntervalMinutes: 15,
  encryptionEnabled: false,
}

const CONFIG_KEY = 'lg_intents_config'
const ACTIVITY_KEY = 'lg_intents_activity'
const CURSOR_KEY = 'lg_intents_cursor'
const MAX_ACTIVITY = 50

// Fired whenever the Activity Log changes (a new entry, or a delivery-state
// reconcile) so an open Activity Log view can refresh live. Guarded for the node
// test environment, where window is absent.
export const INTENTS_ACTIVITY_EVENT = 'lg:intents-activity'
function notifyActivityChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(INTENTS_ACTIVITY_EVENT))
}

// Forward-only delivery rank: a transition only "sticks" if it is strictly ahead
// of the current state, so a late or out-of-order flush can never downgrade a
// chip (e.g. delivered -> held) or rewrite an unchanged one.
const DELIVERY_RANK: Record<IntentDelivery, number> = { queued: 0, held: 1, delivered: 2 }

export function getIntentsConfig(): IntentsConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (!raw) return { ...DEFAULT_CONFIG }
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveIntentsConfig(config: IntentsConfig): void {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config))
}

export function isIntentsConfigured(config: IntentsConfig): boolean {
  return config.enabled && Boolean(config.webdavUrl) && Boolean(config.webdavUsername) && Boolean(config.webdavPassword)
}

export function getActivityLog(): ActivityEntry[] {
  try {
    const raw = localStorage.getItem(ACTIVITY_KEY)
    if (!raw) return []
    return JSON.parse(raw) as ActivityEntry[]
  } catch {
    return []
  }
}

export function addActivityEntry(entry: Omit<ActivityEntry, 'id' | 'timestamp'>): void {
  const log = getActivityLog()
  const newEntry: ActivityEntry = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  }
  const updated = [newEntry, ...log].slice(0, MAX_ACTIVITY)
  localStorage.setItem(ACTIVITY_KEY, JSON.stringify(updated))
  notifyActivityChanged()
}

export function clearActivityLog(): void {
  localStorage.removeItem(ACTIVITY_KEY)
  notifyActivityChanged()
}

// Forward-only delivery-state transition over an in-memory log. Updates the
// OUTBOUND ('out') entry matching `eventId` to `next` ONLY when `next` is ahead
// of its current state; returns true iff it changed something. Pure over the
// passed array (no I/O), so it is unit-testable and reused by the reconcile
// wrapper below. A no-op when unchanged keeps repeated flushes from rewriting or
// spamming the log.
export function applyOutboundDelivery(log: ActivityEntry[], eventId: string, next: IntentDelivery): boolean {
  let changed = false
  for (const entry of log) {
    if (entry.direction !== 'out' || entry.eventId !== eventId) continue
    const current = entry.delivery ?? 'queued'
    if (DELIVERY_RANK[next] > DELIVERY_RANK[current]) {
      entry.delivery = next
      changed = true
    }
  }
  return changed
}

// Folds one flush pass's outcome back into the persisted Activity Log. Held ids
// are applied before delivered ids so that, when an id is in both lists, the
// forward-only rule lands it on `delivered` (the higher rank). Writes (and
// notifies) at most once, and only if something actually changed.
export function reconcileDeliveryFromFlush(result: { deliveredIds: string[]; heldNoKeyIds: string[] }): void {
  const log = getActivityLog()
  let changed = false
  for (const id of result.heldNoKeyIds) changed = applyOutboundDelivery(log, id, 'held') || changed
  for (const id of result.deliveredIds) changed = applyOutboundDelivery(log, id, 'delivered') || changed
  if (!changed) return
  localStorage.setItem(ACTIVITY_KEY, JSON.stringify(log))
  notifyActivityChanged()
}

export function getPollingCursor(): string | null {
  return localStorage.getItem(CURSOR_KEY)
}

export function setPollingCursor(timestamp: string): void {
  localStorage.setItem(CURSOR_KEY, timestamp)
}
