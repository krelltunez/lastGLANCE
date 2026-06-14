import { describe, it, expect, beforeEach } from 'vitest'
import { addDeferredChore, removeDeferredChore, getDeferredChores } from './deferredChores'
import type { SyncChore } from './types'

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

function makeChore(id: string): SyncChore {
  return {
    id, name: 'Chore ' + id, categorySyncId: 'cat-' + id, sortOrder: 0,
    targetCadenceDays: 7, notifyWhenOverdue: false, autoScheduleToDayglance: false,
    preferredScheduleBehavior: null, seasonalStart: null, seasonalEnd: null,
    icon: undefined, assignedUserSyncIds: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

describe('deferredChores buffer', () => {
  beforeEach(() => { installLocalStorage() })

  it('starts empty', () => {
    expect(getDeferredChores()).toEqual([])
  })

  it('adds and reads back a parked chore', () => {
    const c = makeChore('a')
    addDeferredChore(c)
    expect(getDeferredChores()).toEqual([c])
  })

  it('dedupes by sync_id, keeping the latest version', () => {
    addDeferredChore(makeChore('a'))
    const updated = { ...makeChore('a'), name: 'renamed' }
    addDeferredChore(updated)
    const all = getDeferredChores()
    expect(all).toHaveLength(1)
    expect(all[0].name).toBe('renamed')
  })

  it('removes a chore and clears storage when empty', () => {
    addDeferredChore(makeChore('a'))
    removeDeferredChore('a')
    expect(getDeferredChores()).toEqual([])
    expect(localStorage.getItem('lastglance-db-deferred-chores')).toBeNull()
  })

  it('removing an absent id is a no-op', () => {
    addDeferredChore(makeChore('a'))
    removeDeferredChore('does-not-exist')
    expect(getDeferredChores().map(c => c.id)).toEqual(['a'])
  })

  it('tolerates malformed stored JSON', () => {
    localStorage.setItem('lastglance-db-deferred-chores', '{not json')
    expect(getDeferredChores()).toEqual([])
  })
})
