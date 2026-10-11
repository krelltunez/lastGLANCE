import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { buildEnvelope, buildEncryptedEnvelope, deriveIntentsRootKey, deriveEnvelopeKey, ACTIONS, EVENTS, SOURCE_APPS } from '@glance-apps/intents'
import { RELAY_CONFIRM_MS, RELAY_STAGGER_MS } from '@glance-apps/sync'
import {
  mergeEventSets, eventTime, isLive, serializeEventSet, parseEventSetText, relativeEventsPath,
  readLedger, ledgerAppend, ledgerLive, getCursor,
  receiveEnvelope, runEventSetCycle, publishOwnEvent, withEventsLock,
  DIRECT_ACCESS_INTENT_LEDGER_KEY, SELF, type RawEnvelope, type EventSetTransport, type EventSetState,
} from './eventSet'

// Intents over Direct Access (docs/direct-access.md, step 3): the event-set
// file. The real @glance-apps/intents codec builds the envelopes; the
// transport is a fake over one shared file, as the syncing tool would ferry it.

function memStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)) },
    removeItem: (k: string) => { m.delete(k) },
  }
}
beforeEach(() => { Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memStorage() }) })
afterAll(() => { delete (globalThis as { localStorage?: unknown }).localStorage })

const DAY = 24 * 60 * 60 * 1000
const RETENTION = 30 * DAY
const T0 = Date.parse('2026-10-11T12:00:00.000Z')

const payload = (title: string) => ({
  event_id: 'evt', source_app: SOURCE_APPS.LASTGLANCE, source_entity_id: 'chore-1', event: EVENTS.COMPLETED,
  task_id: 'task-1', title, timestamp: '2026-10-01T00:00:00.000Z', entity_type: 'task', completed_at: '2026-10-11T11:00:00.000Z',
})
/** A notify envelope from dayGLANCE, emitted `ageMs` before T0. */
const foreign = (title: string, ageMs = 0): RawEnvelope =>
  buildEnvelope({ action: ACTIONS.NOTIFY, payload: payload(title), emittedBy: SOURCE_APPS.DAYGLANCE, emittedAt: new Date(T0 - ageMs) }) as unknown as RawEnvelope
const mine = (title: string, ageMs = 0): RawEnvelope =>
  buildEnvelope({ action: ACTIONS.NOTIFY, payload: payload(title), emittedBy: SELF, emittedAt: new Date(T0 - ageMs) }) as unknown as RawEnvelope

type Folder = { text: string | null; writes: number }
const fakeTransport = (folder: Folder, over: Partial<EventSetTransport> = {}): EventSetTransport => ({
  id: 'fake-da',
  writeThrottleMs: 0,
  events: {
    supported: () => true,
    read: async () => folder.text,
    write: async (_rel: string, text: string) => { folder.text = text; folder.writes++; return true },
  },
  ...over,
})
const fileWith = (...events: RawEnvelope[]) => serializeEventSet(events)
const idsIn = (text: string | null) => (JSON.parse(text!).events as RawEnvelope[]).map((e) => e.event_id).sort()
const quiet = { warn: vi.fn(), error: vi.fn() }

describe('the event set', () => {
  it('eventTime reads the stamp, falls back to the id, and gives up on neither', () => {
    expect(eventTime(foreign('a', 1000))).toBe(T0 - 1000)
    expect(eventTime({ event_id: '20261011T120000Z-abc' })).toBe(T0)
    expect(eventTime({ event_id: 'nope' })).toBeNull()
    expect(isLive(foreign('a', RETENTION), T0, RETENTION)).toBe(true)
    expect(isLive(foreign('a', RETENTION + 1), T0, RETENTION)).toBe(false)
  })

  it('merge is a union keyed by event_id, in id order, without expired envelopes: order-independent and idempotent', () => {
    const a = foreign('a', 3000), b = foreign('b', 2000), old = foreign('old', RETENTION + DAY)
    const ab = mergeEventSets([a, old], [b, a], { now: T0, retentionMs: RETENTION })
    const ba = mergeEventSets([b, a], [a, old], { now: T0, retentionMs: RETENTION })
    expect(ab).toEqual(ba)
    expect(ab.map((e) => e.event_id)).toEqual([a.event_id, b.event_id].sort())
    expect(mergeEventSets(ab, [b], { now: T0, retentionMs: RETENTION })).toEqual(ab)
    expect(mergeEventSets([null, { nope: 1 }, a], [], { now: T0, retentionMs: RETENTION })).toEqual([a])
  })

  it('parses the file through the snapshot classification, and names an object that is not a set', () => {
    expect(parseEventSetText(null)).toEqual({ kind: 'absent' })
    expect(parseEventSetText('{"downloading":true}')).toEqual({ kind: 'downloading' })
    expect(parseEventSetText('{"error":"gone"}')).toEqual({ kind: 'error', error: 'gone' })
    expect(parseEventSetText('not json')).toEqual({ kind: 'unparseable' })
    expect(parseEventSetText('{"data":{}}')).toEqual({ kind: 'no-data' })
    const e = foreign('x')
    expect(parseEventSetText(serializeEventSet([e], 'mac'))).toEqual({ kind: 'set', events: [e], writtenBy: 'mac' })
    expect(relativeEventsPath(undefined)).toBe('GLANCE/events/glance-events.json')
    expect(relativeEventsPath('/Shared/intents/')).toBe('Shared/intents/glance-events.json')
  })
})

describe('the ledger and the cursor', () => {
  it('appends idempotently, prunes expired entries on read, and survives a corrupt record', () => {
    const storage = memStorage()
    const a = mine('a', 1000), old = mine('old', RETENTION + DAY)
    ledgerAppend(a, storage); ledgerAppend(a, storage); ledgerAppend(old, storage)
    expect(Object.keys(readLedger(storage)).sort()).toEqual([a.event_id, old.event_id].sort())
    expect(ledgerLive(storage, T0, RETENTION)).toEqual([a])
    expect(Object.keys(readLedger(storage))).toEqual([a.event_id])
    storage.setItem(DIRECT_ACCESS_INTENT_LEDGER_KEY, '{nope')
    expect(readLedger(storage)).toEqual({})
    expect(getCursor(storage)).toBeNull()
  })
})

describe('receiveEnvelope', () => {
  const log = vi.fn()
  beforeEach(() => log.mockClear())

  it('hands a foreign plaintext envelope to the app, and never this app\'s own, raw or parsed', async () => {
    const handled: string[] = []
    const deps = { handleEnvelope: async (e: { event_id: string }) => { handled.push(e.event_id) }, addActivityEntry: log }
    const f = foreign('From dayGLANCE')
    expect(await receiveEnvelope(f, deps)).toEqual({ handled: true })
    expect(handled).toEqual([f.event_id])
    expect(await receiveEnvelope(mine('Own'), deps)).toEqual({ handled: false, skipped: 'own' })
    expect(handled).toHaveLength(1)
  })

  it('an encrypted envelope: opened with the WebDAV intents root key, skipped and logged without one, skipped with the wrong one', async () => {
    const importRoot = async (pass: string) => deriveIntentsRootKey(pass, new Uint8Array(16).fill(7))
    const right = await importRoot('right'), wrong = await importRoot('wrong')
    const sealed = await buildEncryptedEnvelope(
      { action: ACTIONS.NOTIFY, payload: payload('Sealed'), emittedBy: SOURCE_APPS.DAYGLANCE, emittedAt: new Date(T0) },
      (salt) => deriveEnvelopeKey(right, salt),
    ) as unknown as RawEnvelope
    const handled: string[] = []
    const handleEnvelope = async (e: { event_id: string }) => { handled.push(e.event_id) }
    expect(await receiveEnvelope(sealed, { handleEnvelope, loadKey: async () => right, addActivityEntry: log })).toEqual({ handled: true })
    expect(await receiveEnvelope(sealed, { handleEnvelope, loadKey: async () => null, addActivityEntry: log })).toEqual({ handled: false, skipped: 'no_root_key' })
    const r = await receiveEnvelope(sealed, { handleEnvelope, loadKey: async () => wrong, addActivityEntry: log })
    expect(r.handled).toBe(false)
    expect(handled).toHaveLength(1)
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('a malformed envelope is logged and skipped, never thrown', async () => {
    const r = await receiveEnvelope({ event_id: 'x', emitted_by: 'app.dayglance', action: 'notify' } as RawEnvelope, { handleEnvelope: async () => {}, addActivityEntry: log })
    expect(r.handled).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
  })
})

describe('runEventSetCycle', () => {
  it('a receiver reads, handles what is above its cursor and not its own, advances the cursor, and never writes for what it read', async () => {
    const storage = memStorage()
    const a = foreign('a', 3000), own = mine('own', 2000), b = foreign('b', 1000)
    const folder: Folder = { text: fileWith(a, own, b), writes: 0 }
    const received: string[] = []
    const r = await runEventSetCycle({ transport: fakeTransport(folder), io: { storage, now: () => T0, retentionMs: RETENTION, receive: async (e) => { received.push(e.event_id) }, log: quiet }, state: null })
    expect(r.outcome).toMatchObject({ kind: 'merged', received: 2, wrote: false, deferred: false })
    expect(received).toEqual([a.event_id, b.event_id])
    expect(getCursor(storage)).toBe(b.event_id)
    expect(folder.writes).toBe(0)
    const again = await runEventSetCycle({ transport: fakeTransport(folder), io: { storage, now: () => T0, retentionMs: RETENTION, receive: async () => {}, log: quiet }, state: r.state })
    expect(again.outcome).toMatchObject({ received: 0 })
  })

  it('an absent file with nothing of our own is left absent: a receiver never seeds', async () => {
    const folder: Folder = { text: null, writes: 0 }
    const r = await runEventSetCycle({ transport: fakeTransport(folder), io: { storage: memStorage(), now: () => T0, retentionMs: RETENTION, receive: async () => {}, log: quiet }, state: null })
    expect(r.outcome).toMatchObject({ kind: 'merged', wrote: false })
    expect(folder.text).toBeNull()
  })

  it('a sender writes its own events at once, seeding an absent file or adding to one, carrying any pending drops', async () => {
    const storage = memStorage()
    const own = mine('own', 1000)
    ledgerAppend(own, storage)
    const folder: Folder = { text: null, writes: 0 }
    const r1 = await runEventSetCycle({ transport: fakeTransport(folder), io: { storage, now: () => T0, retentionMs: RETENTION, deviceId: 'phone', log: quiet }, state: null })
    expect(r1.outcome).toMatchObject({ wrote: true, own: true, confirmed: [] })
    expect(JSON.parse(folder.text!)).toMatchObject({ version: 1, writtenBy: 'phone' })
    expect(idsIn(folder.text)).toEqual([own.event_id])
    const stale = foreign('stale', RETENTION + DAY), live = foreign('live', 500), own2 = mine('own2', 200)
    folder.text = fileWith(stale, live, own)
    ledgerAppend(own2, storage)
    const r2 = await runEventSetCycle({ transport: fakeTransport(folder), io: { storage, now: () => T0, retentionMs: RETENTION, log: quiet }, state: r1.state })
    expect(r2.outcome).toMatchObject({ wrote: true, own: true, confirmed: [own.event_id], dropped: 1 })
    expect(idsIn(folder.text)).toEqual([live.event_id, own.event_id, own2.event_id].sort())
  })

  it('guard: a drop alone is a relay, written only after the file has sat unchanged for the relay wait', async () => {
    const storage = memStorage()
    const stale = foreign('stale', RETENTION + DAY), live = foreign('live', 500)
    const folder: Folder = { text: fileWith(stale, live), writes: 0 }
    let now = T0
    const io = { storage, now: () => now, retentionMs: RETENTION, log: quiet }
    const r1 = await runEventSetCycle({ transport: fakeTransport(folder), io, state: null })
    expect(r1.outcome).toMatchObject({ wrote: false, deferred: true, dropped: 1 })
    now += RELAY_CONFIRM_MS - 1
    const r2 = await runEventSetCycle({ transport: fakeTransport(folder), io, state: r1.state })
    expect(r2.outcome).toMatchObject({ wrote: false, deferred: true })
    now += 2
    const r3 = await runEventSetCycle({ transport: fakeTransport(folder), io, state: r2.state })
    expect(r3.outcome).toMatchObject({ wrote: true, deferred: false })
    expect(idsIn(folder.text)).toEqual([live.event_id])
  })

  it('maps the file states: unsupported, downloading, unparseable, not a set, unavailable; nothing written, cursor untouched', async () => {
    const storage = memStorage()
    const io = { storage, now: () => T0, retentionMs: RETENTION, receive: async () => {}, log: quiet }
    const folder: Folder = { text: null, writes: 0 }
    const t = fakeTransport(folder)
    expect((await runEventSetCycle({ transport: { ...t, events: { ...t.events, supported: () => false } }, io, state: null })).outcome).toEqual({ kind: 'skipped', reason: 'unsupported' })
    folder.text = '{"downloading":true}'
    expect((await runEventSetCycle({ transport: t, io, state: null })).outcome).toEqual({ kind: 'skipped', reason: 'downloading' })
    folder.text = 'nope'
    expect((await runEventSetCycle({ transport: t, io, state: null })).outcome).toEqual({ kind: 'skipped', reason: 'unparseable' })
    folder.text = '{"data":{}}'
    expect((await runEventSetCycle({ transport: t, io, state: null })).outcome).toEqual({ kind: 'skipped', reason: 'no-data' })
    folder.text = '{"error":"folder gone"}'
    expect((await runEventSetCycle({ transport: t, io, state: null })).outcome).toEqual({ kind: 'error', reason: 'unavailable', error: 'folder gone' })
    expect(folder.writes).toBe(0)
    expect(getCursor(storage)).toBeNull()
  })

  it('a handler that throws is logged, the cursor still moves past the envelope, and the rest are handled', async () => {
    const storage = memStorage()
    const a = foreign('a', 2000), b = foreign('b', 1000)
    const folder: Folder = { text: fileWith(a, b), writes: 0 }
    const warn = vi.fn()
    const r = await runEventSetCycle({ transport: fakeTransport(folder), io: { storage, now: () => T0, retentionMs: RETENTION, receive: async (e) => { if (e.event_id === a.event_id) throw new Error('boom') }, log: { warn, error: vi.fn() } }, state: null })
    expect(r.outcome).toMatchObject({ received: 1 })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(getCursor(storage)).toBe(b.event_id)
  })
})

describe('publishOwnEvent (the deliverer\'s half)', () => {
  it('records the envelope, writes, and reports true once the file reads back with it; false when the write fails', async () => {
    const storage = memStorage()
    const folder: Folder = { text: null, writes: 0 }
    const own = mine('own', 1000)
    expect(await publishOwnEvent(fakeTransport(folder), own, { storage, now: () => T0, retentionMs: RETENTION, log: quiet })).toBe(true)
    expect(idsIn(folder.text)).toEqual([own.event_id])
    expect(Object.keys(readLedger(storage))).toEqual([own.event_id])
    // Already there: confirmed without a write.
    expect(await publishOwnEvent(fakeTransport(folder), own, { storage, now: () => T0, retentionMs: RETENTION, log: quiet })).toBe(true)
    expect(folder.writes).toBe(1)
    const broken = fakeTransport(folder, { events: { supported: () => true, read: async () => folder.text, write: async () => false } })
    expect(await publishOwnEvent(broken, mine('other', 500), { storage, now: () => T0, retentionMs: RETENTION, log: quiet })).toBe(false)
  })

  it('withEventsLock serialises overlapping cycles', async () => {
    const order: string[] = []
    const slow = withEventsLock(async () => { await new Promise((r) => setTimeout(r, 5)); order.push('slow') })
    const fast = withEventsLock(async () => { order.push('fast') })
    await Promise.all([slow, fast])
    expect(order).toEqual(['slow', 'fast'])
  })
})

describe('SCENARIO: two devices on one file', () => {
  it('an intent emitted on one is handled once on the other, survives a conflicted copy, falls out after retention, with relays staggered by rank', async () => {
    const folder: Folder = { text: null, writes: 0 }
    const device = (name: string) => {
      const storage = memStorage()
      const dev = {
        name, storage, clock: T0, handled: [] as string[], state: { lastWriteAt: 0, pendingWrite: null } as EventSetState,
        transport: fakeTransport(folder, { id: name }),
        run: async () => {
          const r = await runEventSetCycle({ transport: dev.transport, io: { storage, now: () => dev.clock, retentionMs: RETENTION, deviceId: name, receive: async (e) => { dev.handled.push(e.event_id) }, log: quiet }, state: dev.state })
          dev.state = r.state
          return r.outcome
        },
        emit: (envelope: RawEnvelope) => publishOwnEvent(dev.transport, envelope, { storage, now: () => dev.clock, retentionMs: RETENTION, deviceId: name, log: quiet }),
      }
      return dev
    }
    const phone = device('phone'), tablet = device('tablet')
    expect(await tablet.run()).toMatchObject({ received: 0, wrote: false })
    // The phone emits (as this app): written at once, read back; the tablet never handles this app's own.
    const e1 = mine('From the phone', 5000)
    expect(await phone.emit(e1)).toBe(true)
    expect(await tablet.run()).toMatchObject({ received: 0 })
    // dayGLANCE on the tablet's folder leaves an event: both devices handle it once.
    const d1 = foreign('From dayGLANCE', 4000)
    folder.text = serializeEventSet([...JSON.parse(folder.text!).events, d1], 'dg')
    expect(await tablet.run()).toMatchObject({ received: 1 })
    expect(await tablet.run()).toMatchObject({ received: 0 })
    expect(await phone.run()).toMatchObject({ received: 1 })
    expect(tablet.handled).toEqual([d1.event_id]); expect(phone.handled).toEqual([d1.event_id])
    // The syncing tool loses the phone's event in a conflict (an older copy wins).
    folder.text = fileWith(d1)
    expect(await tablet.run()).toMatchObject({ received: 0, wrote: false })   // not its event: re-adds nothing
    expect(await phone.run()).toMatchObject({ wrote: true, own: true })        // the phone's ledger restores it
    expect(idsIn(folder.text)).toEqual([e1.event_id, d1.event_id].sort())
    // After retention they fall out: the tablet has seen writers "dg" and "phone", both sort before it, so it waits two extra minutes.
    phone.clock += RETENTION + DAY; tablet.clock += RETENTION + DAY
    expect(await tablet.run()).toMatchObject({ deferred: true, dropped: 2 })
    tablet.clock += RELAY_CONFIRM_MS + RELAY_STAGGER_MS
    expect(await tablet.run()).toMatchObject({ deferred: true })
    tablet.clock += RELAY_STAGGER_MS
    expect(await tablet.run()).toMatchObject({ wrote: true })
    expect(idsIn(folder.text)).toEqual([])
    expect(readLedger(phone.storage)).not.toEqual({})
    expect(await phone.run()).toMatchObject({ wrote: false })
    expect(readLedger(phone.storage)).toEqual({})
  })
})
