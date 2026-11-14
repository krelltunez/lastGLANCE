// What this device has sent to dayGLANCE for each chore, and whether it has
// heard back since (the duplicate-send warning of lastglance_send_to_dayglance).
//
// Best effort, by design: it knows only what THIS device sent, and "heard
// back" means a completed or deleted notice from dayGLANCE for the chore. It
// cannot see a dayGLANCE task the user finished in lastGLANCE instead (that
// leaves the task open there), nor one another device sent. So the warning
// says "no word since", never "still open". Device-local storage, not synced.

const KEY = 'lg-dg-sent'
/** Older records are dropped: by then the task is long gone or long forgotten. */
export const SENT_KEEP_DAYS = 60

export interface SentRecord {
  /** The task id dayGLANCE gives it (dayglanceTaskId.ts). */
  taskId: string
  /** The due it was sent with: a date, a time with its offset, or null for the inbox. */
  due: string | null
  sentAt: string
}

type Ledger = Record<string, SentRecord>

function read(): Ledger {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Ledger : {}
  } catch { return {} }
}

function write(ledger: Ledger): void {
  try { localStorage.setItem(KEY, JSON.stringify(ledger)) } catch { /* best effort */ }
}

/** Remember a send of this chore (the latest one wins). */
export function recordSent(choreSyncId: string, record: SentRecord, now = new Date()): void {
  const ledger = read()
  const cutoff = now.getTime() - SENT_KEEP_DAYS * 86_400_000
  for (const [id, r] of Object.entries(ledger)) if (Date.parse(r.sentAt) < cutoff) delete ledger[id]
  ledger[choreSyncId] = record
  write(ledger)
}

/** The last send of this chore this device has had no word on since, or null. */
export function unansweredSend(choreSyncId: string, now = new Date()): SentRecord | null {
  const r = read()[choreSyncId]
  if (!r) return null
  return Date.parse(r.sentAt) >= now.getTime() - SENT_KEEP_DAYS * 86_400_000 ? r : null
}

/** dayGLANCE reported the task completed or deleted: there is word on it. */
export function clearSent(choreSyncId: string): void {
  const ledger = read()
  if (!(choreSyncId in ledger)) return
  delete ledger[choreSyncId]
  write(ledger)
}
