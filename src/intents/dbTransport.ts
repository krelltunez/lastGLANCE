// App-owned GLANCEvault DB transport for INTENTS.
//
// @glance-apps/intents is a CODEC, not a transport: its src/vault/ helpers
// (buildIntentRow / parseIntentRow / parseSince / formatSince) only encode and
// decode the wire row. THIS module owns delivery — HTTP, the device-token auth,
// pagination, and routing decoded envelopes into the app's existing intent
// handling. It mirrors how the WebDAV intents transport is app-owned (poller,
// cursor, HTTP) and uses the package only for the envelope codec.
//
// Server contract (authoritative):
//   WRITE  POST {vaultUrl}/intents/batch
//     body { accountId, events: [ { eventId, envelope(base64), expiresAt(ISO) } ] }
//     resp { written, maxSeq }   — insert-only; a re-sent eventId is a no-op.
//   LIST   GET  {vaultUrl}/intents/list?accountId=&since=&limit=
//     resp { rows: [ { eventId, envelope(base64), seq, expiresAt, serverMtime } ], hasMore }
//     seq > since, ascending; only non-expired rows are returned.
//   Auth: same device-token bearer as the GLANCEvault sync transport.

import { buildIntentRow, parseIntentRow } from '@glance-apps/intents'
import type { OutboundIntentRow, IntentEventRow } from '@glance-apps/intents'
import { isNativePlatform, nativeHttpFetch } from '@/sync/nativeHttp'
import { getVaultConfig } from '@/sync/vaultConfig'
import type { ChoreWithLastCompletion } from '@/types'
import { getIntentsConfig, addActivityEntry } from './config'
import { getDbIntentsConfig } from './dbConfig'
import { buildCreateEnvelope, IntentsKeyMissingError } from './buildCreateEnvelope'

// Server default list page size. The client never sends fewer; it just keeps
// paging on `hasMore` until the backlog is drained (see receiveAllIntents).
export const DEFAULT_LIST_LIMIT = 500

const REQUEST_TIMEOUT_MS = 15_000

interface VaultResponse {
  status: number
  ok: boolean
  text: () => Promise<string>
}

export interface VaultConn {
  vaultUrl: string
  vaultToken: string
  accountId: string
}

// Resolves the shared GLANCEvault connection (url, device token, account id).
// Returns null when the vault is not configured — callers treat that as "DB
// intents not available" and no-op. Exported so the intents deliverers can reuse
// the exact same connection + fetch path the receive/send drains use.
export function getConn(): VaultConn | null {
  const v = getVaultConfig()
  if (!v || !v.vaultUrl || !v.vaultToken || !v.accountId) return null
  return { vaultUrl: v.vaultUrl, vaultToken: v.vaultToken, accountId: v.accountId }
}

// Single HTTP entry point. Uses the same device-token bearer the sync transport
// uses (Authorization: Bearer <token>). On native (Capacitor) it goes straight
// through the native HTTP stack, CORS-free; in the browser/PWA it uses fetch
// directly against the vault server (which serves CORS, unlike WebDAV).
export async function vaultFetch(
  conn: VaultConn,
  method: string,
  path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
): Promise<VaultResponse> {
  const base = conn.vaultUrl.replace(/\/+$/, '')
  let url = base + path
  if (opts.query) {
    const qs = new URLSearchParams(opts.query).toString()
    if (qs) url += `?${qs}`
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${conn.vaultToken}` }
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : null
  if (body !== null) headers['Content-Type'] = 'application/json'

  if (isNativePlatform) {
    const r = await nativeHttpFetch(method, url, headers, body)
    return { status: r.status, ok: r.ok, text: async () => r.body }
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'AbortError')), REQUEST_TIMEOUT_MS)
  return fetch(url, {
    method,
    headers,
    ...(body !== null ? { body } : {}),
    signal: controller.signal,
  }).finally(() => clearTimeout(timer))
}

export interface BatchResult {
  written: number
  maxSeq: number
}

// POST a batch of insert-only intent rows. The accountId is a top-level field
// of the batch body, NOT part of any row — sending is structurally incapable of
// advancing a receive cursor. Re-sending a row whose eventId already exists is a
// server-side no-op, so a failed/retried send is always safe.
export async function postIntentsBatch(events: OutboundIntentRow[]): Promise<BatchResult | null> {
  const conn = getConn()
  if (!conn) return null
  const res = await vaultFetch(conn, 'POST', '/intents/batch', {
    body: { accountId: conn.accountId, events },
  })
  if (!res.ok) throw new Error(`intents batch failed: ${res.status}`)
  return JSON.parse(await res.text()) as BatchResult
}

export interface ListPage {
  rows: IntentEventRow[]
  hasMore: boolean
}

// GET one page of intents with seq > since (ascending). Each raw row is run
// through the codec's parseIntentRow, which validates the camelCase/base64 wire
// shape and decodes the envelope back to a structured object.
export async function listIntentsPage(since: number, limit = DEFAULT_LIST_LIMIT): Promise<ListPage | null> {
  const conn = getConn()
  if (!conn) return null
  const res = await vaultFetch(conn, 'GET', '/intents/list', {
    query: { accountId: conn.accountId, since: String(since), limit: String(limit) },
  })
  if (!res.ok) throw new Error(`intents list failed: ${res.status}`)
  const data = JSON.parse(await res.text()) as { rows: unknown[]; hasMore: boolean }
  return {
    rows: data.rows.map((r) => parseIntentRow(r)),
    hasMore: data.hasMore === true,
  }
}

// A handler that throws this many CONSECUTIVE times on the same seq is treated
// as poison and given up on (advanced past), so a permanently-bad row cannot
// wedge the channel forever. Below the threshold a throw is assumed transient
// and the drain stops to retry from the same cursor next poll. Identical
// name/value to dayGLANCE's intents drain.
export const MAX_INTENT_RETRIES = 5

export interface ReceiveDeps {
  // Reads the app-owned receive cursor (null = from the beginning / full backlog).
  getCursor: () => number | null
  // Persists the advanced receive cursor. Only ever called from the receive loop.
  setCursor: (seq: number) => void
  // Fetches one page from `since`. Injected so tests can drive the pagination
  // loop without a server; the poller passes listIntentsPage.
  listPage: (since: number) => Promise<ListPage | null>
  // Handles one decoded row. Returns normally on success OR on a decode/
  // permanent-bad row (which it skip-logs internally). THROWS only when the
  // handler itself failed (e.g. a transient IndexedDB error) — that throw drives
  // the bounded-retry path below.
  processRow: (row: IntentEventRow) => Promise<void>
  // Persisted per-seq failure counters (survive poll cycles / reloads). Inject
  // so tests can drive retries in-memory; the poller wires the localStorage ones.
  recordFailure: (seq: number) => number // increment, return new consecutive count
  clearFailure: (seq: number) => void
  // Called when a seq is given up on after MAX_INTENT_RETRIES, so the app can log
  // loudly with the row's eventId. Optional (logging only).
  onGiveUp?: (row: IntentEventRow, err: unknown, failures: number) => void
}

// RECEIVE with PAGINATION + BOUNDED RETRY. Reading .rows once would silently
// truncate any backlog over one page (default 500). So we LOOP: read .rows,
// process them, advance the cursor to the last row's seq, and if hasMore is true
// immediately list again from the new cursor — until hasMore is false.
//
// Per-row handling is a three-way model so one bad row can neither abort the
// drain nor wedge the channel:
//   1. processRow returns       -> success / decode-skip: advance, clear, continue.
//   2. processRow THROWS, count < MAX -> assumed transient: STOP the drain,
//      cursor unadvanced, so the next poll retries this seq from here.
//   3. processRow THROWS, count >= MAX -> poison: log, advance past it, clear,
//      continue (the channel must not wedge on one permanently-bad row).
//
// Returns the number of rows consumed (advanced past — successes, decode-skips,
// and give-ups). The cursor advances ONLY here, from intents actually received;
// nothing in the send path can move it.
export async function receiveAllIntents(deps: ReceiveDeps): Promise<number> {
  let cursor = deps.getCursor() ?? 0
  let processed = 0

  for (;;) {
    const page = await deps.listPage(cursor)
    if (!page) break

    for (const row of page.rows) {
      try {
        await deps.processRow(row)
      } catch (err) {
        // HANDLER THREW — catch so it can no longer abort the drain. Do NOT
        // advance the cursor yet; bump this seq's persisted consecutive-failure
        // count and decide retry vs give-up.
        const failures = deps.recordFailure(row.seq)
        if (failures >= MAX_INTENT_RETRIES) {
          // Poison row: give up so the channel can't wedge forever. Log loudly
          // (with eventId), advance past it, and clear its counter.
          deps.onGiveUp?.(row, err, failures)
          deps.clearFailure(row.seq)
          cursor = row.seq
          deps.setCursor(cursor)
          processed++
          continue
        }
        // Below the threshold — assume transient. Stop the WHOLE drain for this
        // poll with the cursor unadvanced; the next poll resumes from this seq
        // and retries it. Return cleanly (do not re-throw).
        return processed
      }

      // No throw: success or a decode/permanent-bad skip. Advance past the row.
      // Clear any failure counter for this seq (success path; a never-failed seq
      // is a harmless no-op). THE CURSOR MAY LEGITIMATELY ADVANCE PAST A SEQ
      // WHOSE INTENT EXPIRED before this device listed it: the server returns
      // only non-expired rows, so an expired intent is simply never delivered
      // and its seq is skipped. THIS IS CORRECT AND INTENDED (TTL means a stale
      // intent is meant to be missed) — it is NOT the sync cursor-skip bug and
      // must not be "fixed" by re-listing from a lower seq.
      deps.clearFailure(row.seq)
      cursor = row.seq
      deps.setCursor(cursor)
      processed++
    }

    if (!page.hasMore) break
    // hasMore — there is more backlog beyond this page. List again immediately
    // from the just-advanced cursor rather than waiting for the next poll tick.
  }

  return processed
}

// SEND one CREATE intent over the DB transport. Mirrors emitCreateIntent's
// WebDAV path but encodes the envelope into a vault row via the codec and POSTs
// the batch wrapper. Returns true on success.
//
// NOTE: this never reads or writes the receive cursor. The batch body carries
// accountId at the top level and the row carries no seq, so sending cannot
// advance what this device has received.
export async function sendCreateIntent(chore: ChoreWithLastCompletion): Promise<boolean> {
  const conn = getConn()
  if (!conn) return false

  try {
    const encryptionEnabled = getIntentsConfig().encryptionEnabled
    const envelope = await buildCreateEnvelope(chore, encryptionEnabled)
    // buildIntentRow lifts envelope.event_id to the row's top-level eventId (the
    // server idempotency key) and computes ttlMs from the envelope's emitted_at,
    // so re-sending the same chore produces a byte-identical, idempotent row.
    const row = buildIntentRow(envelope, { ttlMs: getDbIntentsConfig().ttlMs })

    const result = await postIntentsBatch([row])
    if (!result) return false

    addActivityEntry({ type: 'sent', message: `Sent "${chore.name}" to dayGLANCE` })
    return true
  } catch (err) {
    if (err instanceof IntentsKeyMissingError) {
      addActivityEntry({ type: 'error', message: 'intents encryption setup incomplete — open Settings to complete setup' })
      return false
    }
    const message = err instanceof Error ? err.message : String(err)
    addActivityEntry({ type: 'error', message: `Failed to send "${chore.name}" to dayGLANCE`, detail: message })
    return false
  }
}
