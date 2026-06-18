// Multi-device cursor-ordering test for the GLANCEvault DB transport.
//
// Regression guard for the cursor bug fixed in @glance-apps/sync 1.4.0: a PUSH
// must not advance the PULL cursor, otherwise a device that pushes local dirty
// rows in the same cycle it has unread, lower-seq remote rows from a peer would
// skip those remote rows permanently — fatal for insert-only completion events,
// which are never re-written and so never recovered.
//
// lastGLANCE keeps using the engine's default dbSyncCycle (push-then-pull); the
// fix lives in the package (KEY_HWM pull cursor split from KEY_PUSH_ACK). This
// test drives the real engine against an in-memory vault, using lastGLANCE's own
// insert-only / last-modified classifiers, and asserts neither device skips the
// other's rows. It would FAIL on 1.3.2 and MUST PASS on 1.4.0.

import 'fake-indexeddb/auto'
import { webcrypto } from 'node:crypto'
import { describe, it, expect, beforeAll } from 'vitest'
import { createDbSyncEngine, setupDbRootKey } from '@glance-apps/sync'
import type { VaultClient } from '@glance-apps/sync'
import { isInsertOnly, getEntityLastModified } from './dbEngine'

// WebCrypto global for the encrypt/decrypt path (Node exposes it; guard anyway).
if (!(globalThis as { crypto?: Crypto }).crypto) {
  ;(globalThis as { crypto?: Crypto }).crypto = webcrypto as unknown as Crypto
}

// Minimal in-memory localStorage. Both engines share it but use distinct
// storageKeyPrefix values, so their cursors / dirty sets stay isolated.
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
installLocalStorage()

// ── In-memory GLANCEvault ────────────────────────────────────────────────────
// One shared, monotonic seq counter across the whole account — the server-side
// invariant the bug hinges on: rows a device pushes now get the HIGHEST seqs, so
// a peer's earlier, unread rows sit at LOWER seqs.
interface VaultRow { seq: number; entityId: string; envelope: string | null; deleted: boolean }

function makeInMemoryVault() {
  const rows = new Map<string, VaultRow>() // entityId -> latest row
  let seqCounter = 0
  let salt: Uint8Array | null = null

  return {
    pushed() { return [...rows.values()].sort((a, b) => a.seq - b.seq) },

    async getSalt() { return salt },
    async putSalt(_accountId: string, fresh: Uint8Array) { salt ??= fresh; return salt },

    async batch(_app: string, { rows: incoming }: { accountId: string; rows: { entityId: string; envelope: string }[] }) {
      let maxSeq = seqCounter
      for (const r of incoming) {
        const seq = ++seqCounter
        rows.set(r.entityId, { seq, entityId: r.entityId, envelope: r.envelope, deleted: false })
        maxSeq = seq
      }
      return { maxSeq, written: incoming.length }
    },

    async deleteRow(_app: string, entityId: string) {
      const seq = ++seqCounter
      rows.set(entityId, { seq, entityId, envelope: null, deleted: true })
      return { seq }
    },

    async list(_app: string, { since }: { accountId: string; since: number }) {
      const out = [...rows.values()].filter(r => r.seq > since).sort((a, b) => a.seq - b.seq)
      return { rows: out, hasMore: false }
    },

    async device() { return { updated: true } },
  }
}

// ── Per-device local store + lastGLANCE-real adapter callbacks ────────────────
// getLocalEntity / applyRemoteEntity / applyRemoteDelete are per-device (each
// device has its own data), while isInsertOnly / getEntityLastModified are
// lastGLANCE's actual production classifiers.
function makeDevice(id: string, vault: ReturnType<typeof makeInMemoryVault>) {
  const local = new Map<string, Record<string, unknown>>()
  const engine = createDbSyncEngine({
    storageKeyPrefix: `dev-${id}`,
    appId: 'lastglance',
    vaultApp: 'lastglance',
    cryptoDBName: 'test-crypto',
    accountId: 'acct-1',
    deviceId: id,
    // Intentionally-minimal test double; cast to the full client contract.
    vaultClient: vault as unknown as VaultClient,
    getLocalEntity: async (entityId: string) => local.get(entityId) ?? null,
    applyRemoteEntity: async (entityId: string, entity: unknown) => { local.set(entityId, entity as Record<string, unknown>) },
    applyRemoteDelete: async (entityId: string) => { local.delete(entityId) },
    isInsertOnly,
    getEntityLastModified,
  })
  // Create a local entity and mark it dirty (mirrors the app's write path).
  const create = (entity: Record<string, unknown>) => {
    local.set(entity.id as string, entity)
    engine.markDirty(entity.id as string)
  }
  return { id, engine, local, create, has: (eid: string) => local.has(eid) }
}

const cat = (id: string, updatedAt: string) => ({
  id, name: `cat-${id}`, sortOrder: 0, icon: 'Car', parentId: null,
  assignedUserSyncIds: [], updatedAt,
})
const event = (id: string, choreSyncId: string, completedAt: string) => ({
  id, choreSyncId, completedAt, note: null, source: 'manual', completedByUserSyncId: null,
})

beforeAll(async () => {
  // Derive the per-account root key once; both engines share the process-level
  // _rootKey, so each engine's ensureRootKey short-circuits.
  await setupDbRootKey('test-passphrase', new Uint8Array(16).fill(7), { cryptoDBName: 'test-crypto' })
})

describe('GLANCEvault multi-device cursor ordering (1.4.0 fix)', () => {
  it('a push does not advance the pull cursor, so unread lower-seq remote rows are still pulled', async () => {
    const vault = makeInMemoryVault()
    const peer = makeDevice('peer', vault)
    const me = makeDevice('me', vault)

    // Peer publishes a completion event first → lands at the lowest seq (1).
    peer.create(event('e-peer', 'chore-x', '2026-01-01T00:00:00.000Z'))
    await peer.engine.dbSyncCycle()
    expect(vault.pushed()[0].seq).toBe(1)

    // I have a local dirty row AND that unread, lower-seq peer row in one cycle.
    me.create(cat('c-me', '2026-02-02T00:00:00.000Z'))

    // Direct proof of the cursor split: push alone must NOT move the pull cursor.
    await me.engine.pushDirtyRows()
    expect(me.engine.getHighWaterMark()).toBe(0)      // pull cursor untouched by push
    expect(me.engine.getPushAck()).toBeGreaterThan(0) // push-ack advanced instead

    // Pull from the (still 0) cursor → the peer's seq-1 event is listed and applied.
    await me.engine.pullRemoteChanges()
    expect(me.has('e-peer')).toBe(true)
  })

  it('two devices, each with dirty rows + unread peer rows in the same cycle, skip nothing', async () => {
    const vault = makeInMemoryVault()
    const A = makeDevice('A', vault)
    const B = makeDevice('B', vault)

    // B syncs first: its category + completion event land at low seqs (1, 2).
    B.create(cat('cat-B', '2026-03-01T00:00:00.000Z'))
    B.create(event('evt-B', 'chore-B', '2026-03-02T00:00:00.000Z'))
    await B.engine.dbSyncCycle()

    // A now has its own dirty rows AND B's unread, lower-seq rows in one cycle.
    A.create(cat('cat-A', '2026-04-01T00:00:00.000Z'))
    A.create(event('evt-A', 'chore-A', '2026-04-02T00:00:00.000Z'))
    await A.engine.dbSyncCycle() // push A (seq 3,4); pull from cursor 0 → also gets B's 1,2

    // A must have B's rows — especially the insert-only completion event.
    expect(A.has('cat-B')).toBe(true)
    expect(A.has('evt-B')).toBe(true)

    // B gets a fresh dirty row, so B also has dirty rows + unread peer rows (A's
    // seq 3,4) in the same cycle.
    B.create(event('evt-B2', 'chore-B', '2026-05-01T00:00:00.000Z'))
    await B.engine.dbSyncCycle() // push B2 (seq 5,6); pull from cursor 2 → gets A's 3,4

    // B must have A's rows — especially A's insert-only completion event.
    expect(B.has('cat-A')).toBe(true)
    expect(B.has('evt-A')).toBe(true)

    // Sanity: both completion events survived end to end on both devices.
    expect(A.has('evt-A')).toBe(true)
    expect(B.has('evt-B')).toBe(true)
  })
})
