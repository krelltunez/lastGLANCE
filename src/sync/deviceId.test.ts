import { describe, it, expect, beforeEach } from 'vitest'
import { getDeviceId } from './deviceId'

// Minimal in-memory localStorage for the node test environment.
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('getDeviceId', () => {
  beforeEach(() => { installLocalStorage() })

  it('generates a UUID when none is stored', () => {
    expect(localStorage.getItem('lastglance-device-id')).toBeNull()
    const id = getDeviceId()
    expect(id).toMatch(UUID_RE)
    expect(localStorage.getItem('lastglance-device-id')).toBe(id)
  })

  it('returns the same id across multiple calls (stable)', () => {
    const a = getDeviceId()
    const b = getDeviceId()
    const c = getDeviceId()
    expect(b).toBe(a)
    expect(c).toBe(a)
  })

  it('reuses an existing persisted id rather than regenerating', () => {
    const existing = '00000000-1111-2222-3333-444444444444'
    localStorage.setItem('lastglance-device-id', existing)
    expect(getDeviceId()).toBe(existing)
  })
})
