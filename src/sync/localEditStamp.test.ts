import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LOCAL_EDIT_KEY, lastLocalEditAt, markLocalEdit } from './localEditStamp'
import { markDirty, markDeleted, registerDbEngine } from './dirtyTracker'

// The data layer's own writes stamp the local-edit time whether or not the
// vault engine is registered; the Direct Access cycle reads it to tell a
// change made here from one to relay.
describe('local-edit stamp', () => {
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } },
    })
  })
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage
    registerDbEngine(null)
  })

  it('markLocalEdit writes an ISO time under the key and lastLocalEditAt reads it back', () => {
    expect(lastLocalEditAt()).toBeNull()
    markLocalEdit(() => Date.parse('2026-10-11T12:00:00.000Z'))
    expect(store.get(LOCAL_EDIT_KEY)).toBe('2026-10-11T12:00:00.000Z')
    expect(lastLocalEditAt()).toBe('2026-10-11T12:00:00.000Z')
  })

  it('markDirty and markDeleted stamp it with no vault engine registered; a missing id does not', () => {
    markDirty(null)
    expect(lastLocalEditAt()).toBeNull()
    markDirty('11111111-1111-1111-1111-111111111111')
    expect(lastLocalEditAt()).not.toBeNull()
    store.clear()
    markDeleted('11111111-1111-1111-1111-111111111111')
    expect(lastLocalEditAt()).not.toBeNull()
  })

  it('is silent without localStorage', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage
    expect(() => markLocalEdit()).not.toThrow()
    expect(lastLocalEditAt()).toBeNull()
  })
})
