// Durable outbound INTENTS OUTBOX (stage 1: standalone core, not yet wired).
//
// WHY THIS EXISTS
// Today intents are built in memory and fired fire-and-forget: any failure (no
// encryption key yet, a failed POST/PUT, no connection, an app restart mid-send)
// drops them silently — and on the auto-schedule path the "sent today" marker is
// written BEFORE the send, so a failed send is both lost and suppressed. This
// module is the durable spine that fixes that: every intent is persisted before
// any transmit attempt, retried until delivered, and only ever leaves the store
// by being delivered or — after a generous bound — explicitly given up on.
//
// SCOPE / BOUNDARIES (stage 1)
//   * Self-contained: NO imports from the emit sites or the live transports
//     (emitter.ts / dbTransport.ts / webdav.ts). The only collaborators are an
//     injected persistent store and injected "deliver" functions, so the core is
//     fully testable without a network.
//   * LOCAL-ONLY: outbox entries never cross an app boundary, so this module does
//     NOT depend on @glance-apps/intents or @glance-apps/sync.
//   * ENCRYPTION BOUNDARY: the outbox persists and hands deliverers the RAW
//     intent (action + payload + emit metadata) — never a built envelope. The
//     deliverer is what builds + encrypts + sends at flush time. This keeps
//     "encrypt at flush" and "never persist a plaintext envelope to disk"
//     structural: there is no code path here that can write an envelope.

// ── Transport identity ───────────────────────────────────────────────────────
// lastGLANCE has exactly two intents transports: the WebDAV file path and the
// GLANCEvault DB path. There is no iCloud intents path in this app, so it is
// deliberately omitted from the transport set.
export type TransportName = 'webdav' | 'vault'

// A target is delivered, still owed (pending), or abandoned (given-up). The
// last state is the only non-delivery exit; an entry is removed once no target
// remains pending.
export type TargetStatus = 'pending' | 'delivered' | 'given-up'

// ── The raw intent (NEVER an envelope) ───────────────────────────────────────
// This is the transport-agnostic intent as it exists BEFORE any envelope is
// built. event_id doubles as the stable id and the server idempotency key.
export interface OutboxIntent {
  event_id: string
  action: string
  payload: Record<string, unknown>
  emitted_by: string
  emitted_at?: string
}

// ── An outbox entry ──────────────────────────────────────────────────────────
export interface OutboxEntry {
  // Stable unique id == intent.event_id (the idempotency key).
  id: string
  // The RAW intent. Encryption happens at flush in the deliverer; a plaintext
  // (or any) envelope is never stored here.
  intent: OutboxIntent
  createdAt: number
  // transportName -> delivery status for that transport.
  targets: Record<string, TargetStatus>
  // transportName -> consecutive transient-failure count, used for the give-up
  // bound. Tracked PER TARGET (not a single per-entry number) because the bound
  // and the give-up decision are per target: one flaky transport must not push a
  // healthy sibling target toward give-up.
  attempts: Record<string, number>
}

// ── Delivery contract ────────────────────────────────────────────────────────
// A deliverer builds + encrypts + sends the intent over one transport and
// reports the outcome. It must classify its own failures:
//   delivered       — sent (or a confirmed idempotent no-op on the server).
//   transient-fail  — try again later. THIS INCLUDES "encryption key not ready
//                     yet" (e.g. sync not unlocked): the outbox just keeps the
//                     target pending and retries once the deliverer can proceed.
//   permanent-fail  — will never succeed; give up on this target now.
export type DeliveryResult = 'delivered' | 'transient-fail' | 'permanent-fail'
export type Deliverer = (intent: OutboxIntent) => Promise<DeliveryResult>
export type Deliverers = { [transport: string]: Deliverer | undefined }

// Generous bound, much higher than the receive drain's MAX_INTENT_RETRIES (5):
// losing OUTBOUND data is worse than retrying, so we lean hard toward retry.
export const MAX_OUTBOX_ATTEMPTS = 50

// ── Persistent store interface ───────────────────────────────────────────────
// Abstracted so the outbox core is testable against a fake store and so the
// IndexedDB binding stays swappable.
export interface OutboxStore {
  get(id: string): Promise<OutboxEntry | null>
  put(entry: OutboxEntry): Promise<void>
  delete(id: string): Promise<void>
  getAll(): Promise<OutboxEntry[]>
}

// ── IndexedDB-backed store ───────────────────────────────────────────────────
// Mirrors lastGLANCE's existing persistent-state convention (see
// src/intents/intentsKeyStore.ts): a dedicated DB, a single object store keyed by
// id, one short-lived connection per operation.
const DEFAULT_DB_NAME = 'lg-intents-outbox'
const STORE_NAME = 'entries'

function openDB(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(dbName, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export function createIndexedDbOutboxStore(dbName: string = DEFAULT_DB_NAME): OutboxStore {
  return {
    async get(id) {
      const db = await openDB(dbName)
      return new Promise<OutboxEntry | null>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const req = tx.objectStore(STORE_NAME).get(id)
        req.onsuccess = () => resolve((req.result as OutboxEntry | undefined) ?? null)
        req.onerror = () => reject(req.error)
        tx.oncomplete = () => db.close()
      })
    },
    async put(entry) {
      const db = await openDB(dbName)
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        tx.objectStore(STORE_NAME).put(entry)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); reject(tx.error) }
        tx.onabort = () => { db.close(); reject(tx.error) }
      })
    },
    async delete(id) {
      const db = await openDB(dbName)
      return new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        tx.objectStore(STORE_NAME).delete(id)
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => { db.close(); reject(tx.error) }
        tx.onabort = () => { db.close(); reject(tx.error) }
      })
    },
    async getAll() {
      const db = await openDB(dbName)
      return new Promise<OutboxEntry[]>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly')
        const req = tx.objectStore(STORE_NAME).getAll()
        req.onsuccess = () => resolve((req.result as OutboxEntry[] | undefined) ?? [])
        req.onerror = () => reject(req.error)
        tx.oncomplete = () => db.close()
      })
    },
  }
}

// ── The outbox ───────────────────────────────────────────────────────────────
export interface Outbox {
  // Persist an intent owed to every named target, durable before resolving. A
  // repeat event_id is an idempotent no-op (existing progress is preserved).
  enqueue(intent: OutboxIntent, targets: TransportName[]): Promise<void>
  // Attempt every still-pending target of every entry once, applying the result
  // model below. Overlapping flushes are guarded — a flush already in flight
  // makes a concurrent call a no-op, so a target is never delivered twice.
  flush(deliverers: Deliverers): Promise<void>
  // Number of entries still holding undelivered work (diagnostics/tests).
  pendingCount(): Promise<number>
  list(): Promise<OutboxEntry[]>
}

function logGiveUp(entry: OutboxEntry, target: string, reason: string): void {
  // Loud, structured, and includes the event_id + transport so a give-up is
  // never silent — this is the only way an intent leaves the outbox undelivered.
  console.error(
    `[lastglance] intents outbox: GIVING UP on intent ${entry.id} for transport "${target}" — ${reason} (attempts=${entry.attempts[target] ?? 0}/${MAX_OUTBOX_ATTEMPTS}). This intent will not be delivered over this transport.`,
  )
}

export function createOutbox(store: OutboxStore): Outbox {
  // In-flight guard, mirroring the receive drain's `syncing` flag. Set
  // synchronously at the top of flush (before the first await) so a concurrent
  // flush() observes it and bails before any deliverer runs.
  let flushing = false

  async function enqueue(intent: OutboxIntent, targets: TransportName[]): Promise<void> {
    const id = intent.event_id
    if (!id) throw new Error('outbox.enqueue: intent.event_id is required')

    // Idempotent enqueue: a duplicate event_id is a no-op. Crucially we do NOT
    // overwrite an existing entry — that would reset attempts/target progress and
    // could resurrect a target already delivered or given up.
    const existing = await store.get(id)
    if (existing) return

    const targetMap: Record<string, TargetStatus> = {}
    const attempts: Record<string, number> = {}
    for (const t of targets) {
      targetMap[t] = 'pending'
      attempts[t] = 0
    }

    const entry: OutboxEntry = {
      id,
      intent,
      createdAt: Date.now(),
      targets: targetMap,
      attempts,
    }
    // Durable before returning: the caller can treat a resolved enqueue as "this
    // intent will not be lost".
    await store.put(entry)
  }

  async function flush(deliverers: Deliverers): Promise<void> {
    if (flushing) return
    flushing = true
    try {
      const entries = await store.getAll()

      for (const entry of entries) {
        let changed = false

        for (const target of Object.keys(entry.targets)) {
          if (entry.targets[target] !== 'pending') continue

          const deliver = deliverers[target]
          // No deliverer for this transport right now (e.g. it is not currently
          // enabled): leave the target pending, untouched, for a later flush.
          if (!deliver) continue

          let result: DeliveryResult
          try {
            result = await deliver(entry.intent)
          } catch {
            // A deliverer that throws instead of classifying is treated as a
            // transient failure: the outbox must never lose an intent because a
            // deliverer misbehaved.
            result = 'transient-fail'
          }

          if (result === 'delivered') {
            entry.targets[target] = 'delivered'
            changed = true
          } else if (result === 'permanent-fail') {
            // Decisive failure: give up on this target now, bypassing the bound.
            entry.targets[target] = 'given-up'
            changed = true
            logGiveUp(entry, target, 'permanent failure reported by deliverer')
          } else {
            // transient-fail: count it toward the bound and retry next flush,
            // unless we have now hit the bound.
            const n = (entry.attempts[target] ?? 0) + 1
            entry.attempts[target] = n
            changed = true
            if (n >= MAX_OUTBOX_ATTEMPTS) {
              entry.targets[target] = 'given-up'
              logGiveUp(entry, target, `attempt limit reached`)
            }
          }
        }

        // An entry leaves the store once no target is still pending — i.e. every
        // target is either delivered or given-up. Otherwise persist any change so
        // updated attempts/target statuses survive a restart.
        const anyPending = Object.values(entry.targets).some((s) => s === 'pending')
        if (!anyPending) {
          await store.delete(entry.id)
        } else if (changed) {
          await store.put(entry)
        }
      }
    } finally {
      flushing = false
    }
  }

  async function pendingCount(): Promise<number> {
    return (await store.getAll()).length
  }

  async function list(): Promise<OutboxEntry[]> {
    return store.getAll()
  }

  return { enqueue, flush, pendingCount, list }
}

// Default app-wide instance, bound to the IndexedDB store. Constructing it is
// side-effect-free (no connection is opened until a method runs), so importing
// this module is safe in any context. Stage 2 wires emit sites and transports to
// this instance; tests inject their own store via createOutbox().
export const outbox: Outbox = createOutbox(createIndexedDbOutboxStore())
