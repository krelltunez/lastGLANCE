import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { registerDbEngine, markDirty, markDeleted, syncDbNow } from './dirtyTracker'
import type { DbSyncEngine } from '@glance-apps/sync'

describe('dirtyTracker debounced push', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { registerDbEngine(null); vi.useRealTimers() })

  it('does nothing when no engine is registered', () => {
    registerDbEngine(null)
    markDirty('a') // must not throw
    vi.advanceTimersByTime(10_000)
    expect(true).toBe(true)
  })

  it('marks dirty immediately and pushes once after the debounce window', async () => {
    const marked: string[] = []
    let cycles = 0
    const engine = {
      markDirty: (id: string) => { marked.push(id) },
      dbSyncCycle: () => { cycles++; return Promise.resolve() },
    } as unknown as DbSyncEngine
    registerDbEngine(engine)

    markDirty('a')
    expect(marked).toEqual(['a']) // synchronous
    expect(cycles).toBe(0)        // push is deferred

    vi.advanceTimersByTime(2999)
    expect(cycles).toBe(0)
    vi.advanceTimersByTime(1)
    expect(cycles).toBe(1)
  })

  it('collapses a burst of writes into a single push', () => {
    const marked: string[] = []
    let cycles = 0
    const engine = {
      markDirty: (id: string) => { marked.push(id) },
      dbSyncCycle: () => { cycles++; return Promise.resolve() },
    } as unknown as DbSyncEngine
    registerDbEngine(engine)

    markDirty('a')
    vi.advanceTimersByTime(1000)
    markDirty('b')
    vi.advanceTimersByTime(1000)
    markDeleted('c')
    expect(marked).toEqual(['a', 'b', 'c'])
    expect(cycles).toBe(0)

    // Only after the window elapses with no further writes does it fire once.
    vi.advanceTimersByTime(3000)
    expect(cycles).toBe(1)
  })

  it('cancels a pending push when the engine is detached', () => {
    let cycles = 0
    const engine = {
      markDirty: () => {},
      dbSyncCycle: () => { cycles++; return Promise.resolve() },
    } as unknown as DbSyncEngine
    registerDbEngine(engine)

    markDirty('a')
    registerDbEngine(null) // detach before the timer fires
    vi.advanceTimersByTime(10_000)
    expect(cycles).toBe(0)
  })
})

describe('syncDbNow', () => {
  afterEach(() => { registerDbEngine(null) })

  const engineWith = (stamps: Array<string | null>, cycle: () => Promise<unknown> = () => Promise.resolve()) => {
    let i = 0
    return {
      markDirty: () => {},
      getLastSynced: () => stamps[Math.min(i++, stamps.length - 1)],
      dbSyncCycle: cycle,
    } as unknown as DbSyncEngine
  }

  it("is 'off' when the vault engine is not registered", async () => {
    registerDbEngine(null)
    expect(await syncDbNow()).toBe('off')
  })

  it("is 'ok' when the cycle advances the last-synced stamp", async () => {
    registerDbEngine(engineWith([null, '2026-10-31T18:00:00.000Z']))
    expect(await syncDbNow()).toBe('ok')
  })

  it("is 'failed' when the cycle leaves the stamp where it was (the engine reports, never throws)", async () => {
    registerDbEngine(engineWith(['2026-10-31T17:00:00.000Z', '2026-10-31T17:00:00.000Z']))
    expect(await syncDbNow()).toBe('failed')
  })

  it("is 'failed' when the cycle throws", async () => {
    registerDbEngine(engineWith([null, null], () => Promise.reject(new Error('boom'))))
    expect(await syncDbNow()).toBe('failed')
  })

  it('runs the cycle now and drops a pending debounced push', async () => {
    vi.useFakeTimers()
    let cycles = 0
    registerDbEngine(engineWith([null, 'x'], () => { cycles++; return Promise.resolve() }))
    markDirty('a')
    await syncDbNow()
    expect(cycles).toBe(1)
    vi.advanceTimersByTime(10_000)
    expect(cycles).toBe(1)
    vi.useRealTimers()
  })
})
