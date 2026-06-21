import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { IntentEventRow } from '@glance-apps/intents'
import {
  receiveAllIntents,
  postIntentsBatch,
  sendCreateIntent,
  DEFAULT_LIST_LIMIT,
  type ListPage,
} from './dbTransport'
import { getReceiveCursor, setReceiveCursor } from './dbConfig'
import { setVaultConfig } from '@/sync/vaultConfig'
import type { ChoreWithLastCompletion } from '@/types'

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
    const processed = await receiveAllIntents({
      getCursor: () => cursor,
      setCursor: (seq) => { cursor = seq },
      listPage,
      processRow: async (row) => { seen.push(row.seq) },
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
    const processed = await receiveAllIntents({
      getCursor: () => cursor,
      setCursor: (seq) => { cursor = seq },
      listPage,
      processRow: async () => {},
    })
    expect(processed).toBe(3)
    expect(cursor).toBe(5)
    expect(sinceCalls).toEqual([0]) // single page, no re-list
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
