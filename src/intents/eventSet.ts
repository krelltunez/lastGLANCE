// Intents over Direct Access: the event-set file (docs/direct-access.md, step 3).
//
// The WebDAV intents transport is built on a directory: one file per event,
// found by listing. An iPhone on Nextcloud, Drive or Dropbox holds bookmarks
// to files and cannot list a directory or create a file by name, so this
// transport is built on the one primitive every platform has, a single file,
// and is the same on Android and iPhone:
//
//   GLANCE/events/glance-events.json = { version: 1, writtenBy?, events: [envelope, …] }
//
// holding every live envelope, plaintext or encrypted exactly as the WebDAV
// transport builds them. The file is a SET keyed by event_id:
//
//   • The merge is a union that drops envelopes past retention, order-
//     independent and idempotent, so any two copies converge whichever order
//     they are merged in. A syncing tool's last-writer-wins on a collision
//     loses an append, and a conflicted copy is inert; the next merge repairs
//     both.
//   • A sender writes its own events and keeps them until they stick: the
//     ledger holds what this device emitted within retention, and a copy of
//     the file that lost one gets it back from here. Nobody re-adds another
//     device's events: the sender is the one responsible for them.
//   • A receiver reads, never writes for what it read: it handles the
//     envelopes above its cursor that it did not emit, and advances the
//     cursor, exactly as the directory loop does over a listing.
//   • Garbage collection is the merge: expired envelopes fall out of the
//     union, and the device that drops them writes only under the relay rule
//     (the package's relayDecision, staggered by writer rank), so an idle
//     fleet does not take turns rewriting the file. A sender's own write
//     carries pending drops.
//
// This is dayGLANCE's src/intents/folderIntents.js with this app's name, keys
// and receive path. Everything here is pure over an injected transport (the
// `events` slot: by path on Android, a bookmarked file on iOS) and storage;
// the React side is hooks/useDirectAccessIntents.ts.

import {
  parseEnvelope, parseEncryptedEnvelope, deriveEnvelopeKey, SOURCE_APPS,
  NoKeyError, WrongKeyError, NotEncryptedError, MalformedEnvelopeError,
} from '@glance-apps/intents'
import type { Envelope } from '@glance-apps/intents'
import { classifySnapshotText, relayDecision, relayWaitMs, noteWriter } from '@glance-apps/sync'
import { loadIntentsRootKey } from './intentsKeyStore'
import { addActivityEntry as defaultAddActivityEntry } from './config'

export const EVENTS_FILENAME = 'glance-events.json'
export const DEFAULT_EVENTS_PATH = '/GLANCE/events/'
export const DEFAULT_RETENTION_DAYS = 30
const ONE_DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_RETENTION_MS = DEFAULT_RETENTION_DAYS * ONE_DAY_MS
/** This app, as envelopes name it: its own events are never handled. */
export const SELF: string = SOURCE_APPS.LASTGLANCE
/** Per-transport cursor (the WebDAV loop keeps its own). */
export const DIRECT_ACCESS_INTENT_CURSOR_KEY = 'lg_direct_access_intents_cursor'
/** The sender ledger: { [event_id]: envelope } this device emitted, within retention. */
export const DIRECT_ACCESS_INTENT_LEDGER_KEY = 'lg_direct_access_intents_ledger'

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const defaultStorage = (): StorageLike | null => (typeof localStorage === 'undefined' ? null : localStorage)

/** A raw envelope as the file holds it: plaintext or encrypted, keyed by event_id. */
export type RawEnvelope = { event_id: string; emitted_by?: string; emitted_at?: string; encrypted?: boolean } & Record<string, unknown>

/** 'GLANCE/events/glance-events.json', relative to the folder, from the WebDAV-style events directory. */
export const relativeEventsPath = (eventsPath?: string | null): string =>
  `${(eventsPath ?? DEFAULT_EVENTS_PATH).replace(/^\/+/, '').replace(/\/+$/, '')}/${EVENTS_FILENAME}`

// ─── the set ─────────────────────────────────────────────────────────────────

/** When an envelope was emitted: its stamp, else the timestamp its id starts with; null when neither parses. */
export function eventTime(envelope: Partial<RawEnvelope> | null | undefined): number | null {
  const stamp = Date.parse(envelope?.emitted_at ?? '')
  if (Number.isFinite(stamp)) return stamp
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(envelope?.event_id ?? '')
  if (!m) return null
  const t = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`)
  return Number.isFinite(t) ? t : null
}

export const isLive = (envelope: Partial<RawEnvelope> | null | undefined, now: number, retentionMs: number): boolean => {
  const t = eventTime(envelope)
  return t !== null && now - t <= retentionMs
}

/**
 * The union of two sets, keyed by event_id, without expired envelopes, in id
 * order. Order-independent and idempotent. Copies of one id are the same
 * envelope (ids are unique at emit), so the first seen is kept.
 */
export function mergeEventSets(a: unknown[] | null | undefined, b: unknown[] | null | undefined, { now, retentionMs }: { now: number; retentionMs: number }): RawEnvelope[] {
  const byId = new Map<string, RawEnvelope>()
  for (const e of [...(a ?? []), ...(b ?? [])]) {
    if (!e || typeof e !== 'object' || typeof (e as RawEnvelope).event_id !== 'string') continue
    const env = e as RawEnvelope
    if (!isLive(env, now, retentionMs)) continue
    if (!byId.has(env.event_id)) byId.set(env.event_id, env)
  }
  return [...byId.values()].sort((x, y) => x.event_id.localeCompare(y.event_id))
}

/** What a write would change: the ids, in order. */
export const eventSetKey = (events: RawEnvelope[]): string => events.map((e) => e.event_id).join('\n')
export const serializeEventSet = (events: RawEnvelope[], writtenBy: string | null = null): string =>
  JSON.stringify(writtenBy ? { version: 1, writtenBy, events } : { version: 1, events })

export type EventSetRead =
  | { kind: 'absent' | 'downloading' | 'unparseable' | 'no-data' }
  | { kind: 'error'; error: string }
  | { kind: 'set'; events: RawEnvelope[]; writtenBy: string | null }

/** The file's text as the cycle reads it: the snapshot classification plus 'set' with the envelopes, or 'no-data' for JSON that is not a set. */
export function parseEventSetText(text: string | null | undefined): EventSetRead {
  const read = classifySnapshotText(text) as { kind: string; remote?: Record<string, unknown>; error?: string }
  if (read.kind === 'error') return { kind: 'error', error: read.error ?? 'unavailable' }
  if (read.kind !== 'snapshot') return { kind: read.kind as 'absent' | 'downloading' | 'unparseable' }
  const events = read.remote?.events
  if (!Array.isArray(events)) return { kind: 'no-data' }
  return { kind: 'set', events: events as RawEnvelope[], writtenBy: typeof read.remote?.writtenBy === 'string' ? read.remote.writtenBy : null }
}

// ─── the ledger and the cursor ───────────────────────────────────────────────

export function readLedger(storage: StorageLike | null = defaultStorage()): Record<string, RawEnvelope> {
  try {
    const raw = storage?.getItem(DIRECT_ACCESS_INTENT_LEDGER_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function writeLedger(ledger: Record<string, RawEnvelope>, storage: StorageLike | null = defaultStorage()): void {
  try {
    if (Object.keys(ledger).length === 0) storage?.removeItem(DIRECT_ACCESS_INTENT_LEDGER_KEY)
    else storage?.setItem(DIRECT_ACCESS_INTENT_LEDGER_KEY, JSON.stringify(ledger))
  } catch { /* storage unavailable: the outbox still holds the intent */ }
}

/** Records an envelope this device emitted. Idempotent by event_id. */
export function ledgerAppend(envelope: RawEnvelope, storage: StorageLike | null = defaultStorage()): void {
  if (!envelope || typeof envelope.event_id !== 'string') return
  const ledger = readLedger(storage)
  if (!ledger[envelope.event_id]) {
    ledger[envelope.event_id] = envelope
    writeLedger(ledger, storage)
  }
}

/** The live ledger entries, in id order; expired ones are pruned on the way. */
export function ledgerLive(storage: StorageLike | null, now: number, retentionMs: number): RawEnvelope[] {
  const ledger = readLedger(storage)
  const live: Record<string, RawEnvelope> = {}
  let pruned = false
  for (const [id, e] of Object.entries(ledger)) {
    if (isLive(e, now, retentionMs)) live[id] = e
    else pruned = true
  }
  if (pruned) writeLedger(live, storage)
  return Object.values(live).sort((x, y) => x.event_id.localeCompare(y.event_id))
}

export const getCursor = (storage: StorageLike | null): string | null => { try { return storage?.getItem(DIRECT_ACCESS_INTENT_CURSOR_KEY) || null } catch { return null } }
export const setCursor = (storage: StorageLike | null, id: string): void => { try { storage?.setItem(DIRECT_ACCESS_INTENT_CURSOR_KEY, id) } catch { /* ignore */ } }

// ─── receiving one envelope ──────────────────────────────────────────────────

export interface ReceiveDeps {
  /** Handles a parsed envelope (processNotifyEnvelope with the app's deps). */
  handleEnvelope: (envelope: Envelope) => Promise<void>
  /** Loads the WebDAV intents root key, which encrypted events in the folder are sealed with. */
  loadKey?: () => Promise<CryptoKey | null>
  addActivityEntry?: typeof defaultAddActivityEntry
}

export type ReceiveOutcome = { handled: true } | { handled: false; skipped: string }

/**
 * Handles one raw envelope from the set the way the WebDAV loop handles one
 * file: never this app's own; an encrypted one through the WebDAV intents
 * root key (none: logged, skipped); then the app's handler. Never throws for
 * a bad envelope: the cycle advances the cursor past it either way.
 */
export async function receiveEnvelope(raw: RawEnvelope, deps: ReceiveDeps): Promise<ReceiveOutcome> {
  const loadKey = deps.loadKey ?? loadIntentsRootKey
  const log = deps.addActivityEntry ?? defaultAddActivityEntry
  if (raw?.emitted_by === SELF) return { handled: false, skipped: 'own' }

  let envelope: Envelope
  try {
    if (raw?.encrypted === true) {
      const rootKey = await loadKey()
      if (!rootKey) {
        log({ type: 'error', message: `encrypted intent ${raw.event_id} received over Direct Access but intents encryption is not set up on this device` })
        return { handled: false, skipped: 'no_root_key' }
      }
      envelope = await parseEncryptedEnvelope(raw, (salt) => deriveEnvelopeKey(rootKey, salt))
    } else {
      envelope = parseEnvelope(raw)
    }
  } catch (err) {
    let skipped = 'parse_error'
    if (err instanceof NoKeyError) { skipped = 'NoKeyError'; log({ type: 'error', message: `No encryption key available to decrypt intent ${raw?.event_id}` }) }
    else if (err instanceof WrongKeyError) { skipped = 'WrongKeyError'; log({ type: 'error', message: `decryption failed for intent ${raw?.event_id} (root key mismatch — try re-running intents encryption setup)` }) }
    else if (err instanceof NotEncryptedError) { skipped = 'NotEncryptedError'; log({ type: 'error', message: `Intent ${raw?.event_id} is not encrypted as expected` }) }
    else if (err instanceof MalformedEnvelopeError) { skipped = 'MalformedEnvelopeError'; log({ type: 'warning', message: `Malformed envelope ${raw?.event_id} in the Direct Access event set`, detail: err.message }) }
    else log({ type: 'warning', message: `Unparseable envelope ${raw?.event_id} in the Direct Access event set`, detail: err instanceof Error ? err.message : String(err) })
    return { handled: false, skipped }
  }

  if (envelope.emitted_by === SELF) return { handled: false, skipped: 'own' }
  await deps.handleEnvelope(envelope)
  return { handled: true }
}

// ─── the cycle ───────────────────────────────────────────────────────────────

/** What the cycle needs of the transport: the events slot and the relay bookkeeping names. */
export interface EventSetTransport {
  id?: string
  lastSyncedKey?: string
  writeThrottleMs?: number
  events: {
    supported: () => boolean
    read: (relPath: string) => Promise<string | null>
    write: (relPath: string, text: string) => Promise<boolean>
  }
}

export interface EventSetIo {
  storage?: StorageLike | null
  retentionMs?: number
  /** The WebDAV-style events directory ('/GLANCE/events/'). */
  eventsPath?: string | null
  /** Absent: a sender-only cycle (the deliverer), no cursor moves. */
  receive?: (raw: RawEnvelope) => Promise<unknown>
  /** Stamped as `writtenBy`; ranks this device's relay. */
  deviceId?: string | (() => string)
  /** Where the writers seen are kept (default: the snapshot cycle's key for this transport, so the fleet is ranked once). */
  writersKey?: string
  now?: () => number
  log?: Pick<Console, 'warn' | 'error'>
}

export interface EventSetState { lastWriteAt: number; pendingWrite: { fingerprint: string; at: number } | null }

export type EventSetOutcome =
  | { kind: 'skipped'; reason: 'unsupported' | 'downloading' | 'unparseable' | 'no-data' }
  | { kind: 'error'; reason: 'unavailable'; error: string }
  | { kind: 'merged'; received: number; wrote: boolean; deferred: boolean; own: boolean; confirmed: string[]; dropped: number }

/**
 * One cycle over the event-set file: read, merge (file ∪ this device's
 * ledger, minus expired), receive what is new and not ours, write when the
 * merged set differs from the file and the write is this device's to make
 * (an event of its own the file lacks goes out now; anything else, which can
 * only be a drop, waits for the relay rule).
 */
export async function runEventSetCycle({ transport, io = {}, state }: { transport: EventSetTransport; io?: EventSetIo; state: EventSetState | null | undefined }): Promise<{ state: EventSetState; outcome: EventSetOutcome }> {
  const now = io.now ?? Date.now
  const log = io.log ?? console
  const storage = io.storage ?? defaultStorage()
  const retentionMs = io.retentionMs ?? DEFAULT_RETENTION_MS
  const next: EventSetState = { lastWriteAt: state?.lastWriteAt ?? 0, pendingWrite: state?.pendingWrite ?? null }
  if (!transport?.events?.supported()) return { state: next, outcome: { kind: 'skipped', reason: 'unsupported' } }

  const relPath = relativeEventsPath(io.eventsPath)
  const read = parseEventSetText(await transport.events.read(relPath))
  if (read.kind === 'error') return { state: next, outcome: { kind: 'error', reason: 'unavailable', error: read.error } }
  if (read.kind !== 'set' && read.kind !== 'absent') return { state: next, outcome: { kind: 'skipped', reason: read.kind } }
  const fileEvents: RawEnvelope[] = read.kind === 'set' ? read.events : []
  const deviceId = ((): string | null => {
    try { const v = typeof io.deviceId === 'function' ? io.deviceId() : io.deviceId; return typeof v === 'string' && v ? v : null }
    catch { return null }
  })()
  const writersKey = io.writersKey ?? `${transport.lastSyncedKey ?? transport.id ?? 'direct-access'}:writers`
  if (read.kind === 'set' && read.writtenBy !== deviceId && storage) noteWriter(storage, writersKey, read.writtenBy)

  const own = ledgerLive(storage, now(), retentionMs)
  const merged = mergeEventSets(fileEvents, own, { now: now(), retentionMs })
  const fileIds = new Set(fileEvents.map((e) => e?.event_id))

  // Receive: above the cursor, not ours, in id order; the cursor moves past
  // every envelope looked at, handled or not, as the directory loop does.
  let received = 0
  if (typeof io.receive === 'function') {
    const cursor = getCursor(storage)
    for (const e of merged) {
      if (cursor && e.event_id <= cursor) continue
      if (e.emitted_by !== SELF) {
        try { await io.receive(e); received++ }
        catch (err) { log.warn(`[${transport.id ?? 'direct-access'}] intent handling failed:`, (err as Error)?.message ?? err) }
      }
      setCursor(storage, e.event_id)
    }
  }

  // Write: own additions now; drops under the relay rule.
  const fileKey = eventSetKey(fileEvents.filter((e) => e && typeof e.event_id === 'string'))
  const mergedKey = eventSetKey(merged)
  const changed = mergedKey !== fileKey
  const ownMissing = own.some((e) => !fileIds.has(e.event_id))
  const confirmed = own.filter((e) => fileIds.has(e.event_id)).map((e) => e.event_id)
  const throttledWrite = async (): Promise<boolean> => {
    if (now() - next.lastWriteAt < (transport.writeThrottleMs ?? 0)) return false
    next.lastWriteAt = now()
    const ok = await transport.events.write(relPath, serializeEventSet(merged, deviceId))
    if (!ok) log.error(`[${transport.id ?? 'direct-access'}] event set write failed`)
    return ok
  }
  let wrote = false
  let deferred = false
  if (changed && ownMissing) {
    wrote = await throttledWrite()
    next.pendingWrite = null
  } else if (changed) {
    const waitMs = storage ? relayWaitMs(storage, writersKey, deviceId) : undefined
    const decision = relayDecision(next.pendingWrite, `${fileKey}\u0000${mergedKey}`, now(), waitMs)
    next.pendingWrite = decision.pending
    if (decision.write) wrote = await throttledWrite()
    else deferred = true
  } else {
    next.pendingWrite = null
  }
  const dropped = fileEvents.length - merged.filter((e) => fileIds.has(e.event_id)).length
  return { state: next, outcome: { kind: 'merged', received, wrote, deferred, own: ownMissing, confirmed, dropped } }
}

// One cycle at a time per process: the deliverer's sender cycle and the
// poller's receive cycle both read and write the same file. The union makes
// an interleaving safe (a lost append is re-added from the ledger), but
// serialising them spares the collision.
let chain: Promise<unknown> = Promise.resolve()
export function withEventsLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn)
  chain = run.then(() => undefined, () => undefined)
  return run
}

/**
 * The deliverer's half: record the envelope in this device's ledger, run a
 * sender-only cycle (no receive), and report whether the file holds the event
 * once read back. The ledger keeps it until retention either way.
 */
export async function publishOwnEvent(transport: EventSetTransport, envelope: RawEnvelope, io: EventSetIo & { state?: EventSetState } = {}): Promise<boolean> {
  const storage = io.storage ?? defaultStorage()
  ledgerAppend(envelope, storage)
  return withEventsLock(async () => {
    const { outcome } = await runEventSetCycle({ transport, io: { ...io, storage, receive: undefined }, state: io.state ?? { lastWriteAt: 0, pendingWrite: null } })
    if (outcome.kind !== 'merged') return false
    if (outcome.confirmed.includes(envelope.event_id)) return true
    if (!outcome.wrote) return false
    const back = parseEventSetText(await transport.events.read(relativeEventsPath(io.eventsPath)))
    return back.kind === 'set' && back.events.some((e) => e?.event_id === envelope.event_id)
  })
}
