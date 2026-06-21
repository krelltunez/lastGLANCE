import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { IntentEventRow } from '@glance-apps/intents'
import {
  receiveAllIntents,
  postIntentsBatch,
  sendCreateIntent,
  DEFAULT_LIST_LIMIT,
  MAX_INTENT_RETRIES,
  type ListPage,
} from './dbTransport'
import {
  getReceiveCursor,
  setReceiveCursor,
  getReceiveFailureCount,
  recordReceiveFailure,
  clearReceiveFailure,
} from './dbConfig'
import { setVaultConfig } from '@/sync/vaultConfig'
import type { ChoreWithLastCompletion } from '@/types'

// In-memory per-seq failure counters for driving the bounded-retry drain
// without localStorage. Mirrors dbConfig's recordReceiveFailure/clearReceiveFailure.
function memCounters() {
  const counts = new Map<number, number>()
  return {
    recordFailure: (seq: number) => { const n = (counts.get(seq) ?? 0) + 1; counts.set(seq, n); return n },
    clearFailure: (seq: number) => { counts.delete(seq) },
    getCount: (seq: number) => counts.get(seq) ?? 0,
  }
}

function installLocalStorage(): void {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)) },
    removeItem: (k: string) => { store.delete(k) },
    clear: () => { store.clear() },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() { return store.size },
  } as Storage
}

function makeRow(seq: number): IntentEventRow {
  return {
    eventId: `evt-${seq}`,
    envelope: { schema_version: 1, seq },
    seq,
    expiresAt: '2026-12-31T00:00:00.000Z',
    serverMtime: '2026-06-21T00:00:00.000Z',
  }
}

// Pages an in-memory backlog the way the server does: rows with seq > since,
// ascending, at most `pageSize` per call, hasMore when more remain. Records
// every `since` it was asked for so the test can assert the loop re-listed.
function makePagedServer(rows: IntentEventRow[], pageSize: number) {
  const sinceCalls: number[] = []
  const sorted = [...rows].sort((a, b) => a.seq - b.seq)
  const listPage = async (since: number): Promise<ListPage> => {
    sinceCalls.push(since)
    const after = sorted.filter((r) => r.seq > since)
    const page = after.slice(0, pageSize)
    return { rows: page, hasMore: after.length > pageSize }
  }
  return { listPage, sinceCalls }
}

describe('receiveAllIntents — pagination', () => {
  it('drains a >500 backlog completely across pages, advancing the cursor to the last seq', async () => {
    // 1234 rows with NON-CONTIGUOUS seqs (a gap stands in for intents the server
    // omitted because they expired before this device listed — a legitimate skip,
    // not the sync cursor-skip bug).
    const seqs: number[] = []
    let s = 1
    for (let i = 0; i < 1234; i++) {
      s += i === 600 ? 50 : 1 // a 49-seq gap partway through
      seqs.push(s)
    }
    const rows = seqs.map(makeRow)
    const { listPage, sinceCalls } = makePagedServer(rows, DEFAULT_LIST_LIMIT)

    const seen: number[] = []
    let cursor: number | null = null
    const mc = memCounters()
    const processed = await receiveAllIntents({
      getCursor: () => cursor,
      setCursor: (seq) => { cursor = seq },
      listPage,
      processRow: async (row) => { seen.push(row.seq) },
      recordFailure: mc.recordFailure,
      clearFailure: mc.clearFailure,
    })

    // Every row processed exactly once, in ascending order — nothing truncated.
    expect(processed).toBe(1234)
    expect(seen).toEqual(seqs)
    // Cursor ends at the last received seq (past the expiry gap — correct).
    expect(cursor).toBe(seqs[seqs.length - 1])
    // The loop re-listed: 1234 rows / 500 page = 3 list pages (2 full + 1 partial).
    expect(sinceCalls.length).toBe(3)
    expect(sinceCalls[0]).toBe(0)                 // first list from the beginning
    expect(sinceCalls[1]).toBe(seqs[499])         // resumed from page-1's last seq
    expect(sinceCalls[2]).toBe(seqs[999])         // resumed from page-2's last seq
  })

  it('stops after one page when hasMore is false', async () => {
    const rows = [makeRow(3), makeRow(4), makeRow(5)]
    const { listPage, sinceCalls } = makePagedServer(rows, DEFAULT_LIST_LIMIT)
    let cursor: number | null = null
    const mc = memCounters()
    const processed = await receiveAllIntents({
      getCursor: () => cursor,
      setCursor: (seq) => { cursor = seq },
      listPage,
      processRow: async () => {},
      recordFailure: mc.recordFailure,
      clearFailure: mc.clearFailure,
    })
    expect(processed).toBe(3)
    expect(cursor).toBe(5)
    expect(sinceCalls).toEqual([0]) // single page, no re-list
  })
})

describe('receiveAllIntents — bounded retry on handler throw', () => {
  // A server that always lists every row with seq > since on one page. The drain
  // is re-invoked once per "poll cycle" so retries span calls like real polls.
  function singlePageServer(rows: IntentEventRow[]) {
    return async (since: number): Promise<ListPage> => {
      const after = [...rows].sort((a, b) => a.seq - b.seq).filter((r) => r.seq > since)
      return { rows: after, hasMore: false }
    }
  }

  it('(a) retries a row that throws once, then consumes it — not lost', async () => {
    const rows = [makeRow(10), makeRow(11)]
    const listPage = singlePageServer(rows)
    const mc = memCounters()
    let cursor: number | null = null
    const seen: number[] = []
    let shouldThrow = true
    const processRow = async (row: IntentEventRow) => {
      if (row.seq === 10 && shouldThrow) { shouldThrow = false; throw new Error('transient IndexedDB error') }
      seen.push(row.seq)
    }
    const deps = {
      getCursor: () => cursor,
      setCursor: (s: number) => { cursor = s },
      listPage,
      processRow,
      recordFailure: mc.recordFailure,
      clearFailure: mc.clearFailure,
    }

    // Poll 1: seq 10 throws (count < MAX) -> whole drain stops, cursor unadvanced.
    const p1 = await receiveAllIntents(deps)
    expect(p1).toBe(0)
    expect(cursor).toBeNull()        // held at the failing seq, not advanced past it
    expect(mc.getCount(10)).toBe(1)  // one recorded failure
    expect(seen).toEqual([])         // nothing consumed yet — 10 not dropped

    // Poll 2: the SAME seq 10 now succeeds -> advance + clear, then 11 too.
    const p2 = await receiveAllIntents(deps)
    expect(p2).toBe(2)
    expect(seen).toEqual([10, 11])   // 10 was retried, not lost
    expect(cursor).toBe(11)
    expect(mc.getCount(10)).toBe(0)  // counter CLEARED on success
  })

  it('(b) gives up after MAX_INTENT_RETRIES, logs the eventId, and skips so the channel does not wedge', async () => {
    const rows = [makeRow(20), makeRow(21)]
    const listPage = singlePageServer(rows)
    const mc = memCounters()
    const giveUps: Array<{ eventId: string; failures: number }> = []
    let cursor: number | null = null
    const seen: number[] = []
    const processRow = async (row: IntentEventRow) => {
      if (row.seq === 20) throw new Error('permanent handler failure')
      seen.push(row.seq)
    }
    const deps = {
      getCursor: () => cursor,
      setCursor: (s: number) => { cursor = s },
      listPage,
      processRow,
      recordFailure: mc.recordFailure,
      clearFailure: mc.clearFailure,
      onGiveUp: (row: IntentEventRow, _err: unknown, failures: number) => giveUps.push({ eventId: row.eventId, failures }),
    }

    // Polls below the threshold: each stops the drain with the cursor held.
    for (let i = 1; i < MAX_INTENT_RETRIES; i++) {
      const p = await receiveAllIntents(deps)
      expect(p).toBe(0)
      expect(cursor).toBeNull()
      expect(mc.getCount(20)).toBe(i)
      expect(giveUps).toEqual([])    // not given up yet
      expect(seen).toEqual([])       // channel still wedged on 20 (by design, retrying)
    }

    // The MAX-th failure: give up — log with eventId, advance past 20, clear,
    // then 21 is consumed (channel un-wedged).
    const pFinal = await receiveAllIntents(deps)
    expect(giveUps).toEqual([{ eventId: 'evt-20', failures: MAX_INTENT_RETRIES }])
    expect(mc.getCount(20)).toBe(0)  // counter CLEARED on give-up
    expect(seen).toEqual([21])       // 21 now flows — one bad row did not wedge the channel
    expect(cursor).toBe(21)
    expect(pFinal).toBe(2)           // 20 (given up) + 21 (success) advanced past
  })

  it('(c) the failure counter persists across a simulated reload', () => {
    installLocalStorage()
    // Use the REAL persisted counters (localStorage-backed), as the poller does.
    expect(getReceiveFailureCount(77)).toBe(0)
    expect(recordReceiveFailure(77)).toBe(1)
    expect(recordReceiveFailure(77)).toBe(2)

    // "Reload": dbConfig holds no in-memory state, so a fresh read goes back to
    // localStorage, which survives a reload. The raw key holds the count.
    expect(getReceiveFailureCount(77)).toBe(2)
    expect(localStorage.getItem('lg_db_intents_receive_failures')).toBe(JSON.stringify({ '77': 2 }))

    // Clearing removes the entry (and the key once empty), so steady state is clean.
    clearReceiveFailure(77)
    expect(getReceiveFailureCount(77)).toBe(0)
    expect(localStorage.getItem('lg_db_intents_receive_failures')).toBeNull()
  })
})

describe('send path — cursor isolation and idempotency', () => {
  const CHORE = {
    id: 1,
    name: 'Replace HVAC filter',
    sync_id: 'chore-sync-1',
    assigned_user_sync_ids: [],
  } as unknown as ChoreWithLastCompletion

  beforeEach(() => {
    installLocalStorage()
    setVaultConfig({ enabled: true, vaultUrl: 'https://vault.example', vaultToken: 'tok', accountId: 'acct-1' })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('sending an intent does NOT advance the receive cursor', async () => {
    // Seed an existing receive cursor; the send path must never touch it.
    setReceiveCursor(42)

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ written: 1, maxSeq: 99 }),
    })))

    const ok = await sendCreateIntent(CHORE)
    expect(ok).toBe(true)
    // maxSeq=99 came back from the WRITE, but the RECEIVE cursor stays at 42.
    expect(getReceiveCursor()).toBe(42)
  })

  it('re-sending the same eventId is idempotent (server no-op)', async () => {
    // Fake insert-only server: tracks eventIds; a re-sent id writes 0.
    const stored = new Set<string>()
    let nextSeq = 0
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { accountId: string; events: { eventId: string }[] }
      let written = 0
      for (const e of body.events) {
        if (!stored.has(e.eventId)) { stored.add(e.eventId); written++; nextSeq++ }
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ written, maxSeq: nextSeq }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    // Build one row, then POST it twice — the same eventId both times.
    const row = { eventId: 'evt-stable', envelope: 'ZW52', expiresAt: '2026-12-31T00:00:00.000Z' }
    const first = await postIntentsBatch([row])
    const second = await postIntentsBatch([row])

    expect(first).toEqual({ written: 1, maxSeq: 1 })
    expect(second).toEqual({ written: 0, maxSeq: 1 }) // re-send was a no-op
    expect(stored.size).toBe(1)

    // And the batch wrapper on the wire is { accountId, events: [...] }.
    const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(sentBody.accountId).toBe('acct-1')
    expect(sentBody.events[0].eventId).toBe('evt-stable')
  })
})
