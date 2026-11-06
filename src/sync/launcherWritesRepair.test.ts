import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbSyncResult } from '@glance-apps/sync'
import { cycleWithLauncherRepair, LAUNCHER_REPAIR_SINCE, markChangedSince } from './launcherWritesRepair'

class FakeStorage {
  private store = new Map<string, string>()
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null }
  setItem(k: string, v: string): void { this.store.set(k, String(v)) }
  removeItem(k: string): void { this.store.delete(k) }
  clear(): void { this.store.clear() }
  key(i: number): string | null { return Array.from(this.store.keys())[i] ?? null }
  get length(): number { return this.store.size }
}

const FLAG = 'test-launcher-writes-repaired'
const ok = { applied: 0, skipped: 0, skippedEntityIds: [] } as unknown as DbSyncResult

// An engine whose cycle succeeds (lastSynced advances) or fails (it does not).
function engine(succeeds: () => boolean) {
  let lastSynced: string | null = null
  let n = 0
  const runCycle = vi.fn(async () => {
    if (succeeds()) lastSynced = `2026-11-05T00:00:0${++n}.000Z`
    return ok
  })
  return { getLastSynced: () => lastSynced, runCycle }
}

beforeEach(() => {
  ;(globalThis as Record<string, unknown>).localStorage = new FakeStorage()
})

describe('markChangedSince', () => {
  it('marks rows changed on or after the date, and no others', () => {
    const marked: string[] = []
    const n = markChangedSince({ markDirty: (id) => { marked.push(id) } }, [
      { sync_id: 'before', updated_at: '2026-10-25T23:59:59.000Z' },
      { sync_id: 'on', updated_at: LAUNCHER_REPAIR_SINCE },
      { sync_id: 'after', updated_at: '2026-11-04T08:00:00.000Z' },
      { sync_id: 'unstamped' },
    ])
    expect(marked).toEqual(['on', 'after'])
    expect(n).toBe(2)
  })
})

describe('cycleWithLauncherRepair', () => {
  it('waits for a cycle that succeeds: a failed one marks nothing and leaves the flag unset', async () => {
    const e = engine(() => false)
    const mark = vi.fn(async () => 3)
    await cycleWithLauncherRepair(e, e.runCycle, FLAG, mark)
    expect(mark).not.toHaveBeenCalled()
    expect(e.runCycle).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(FLAG)).toBeNull()
  })

  it('after the first successful cycle, marks once and runs a second cycle to push it', async () => {
    const e = engine(() => true)
    const mark = vi.fn(async () => 3)
    await cycleWithLauncherRepair(e, e.runCycle, FLAG, mark)
    expect(mark).toHaveBeenCalledTimes(1)
    expect(e.runCycle).toHaveBeenCalledTimes(2)
    expect(localStorage.getItem(FLAG)).toBe('1')

    // Once only.
    await cycleWithLauncherRepair(e, e.runCycle, FLAG, mark)
    expect(mark).toHaveBeenCalledTimes(1)
    expect(e.runCycle).toHaveBeenCalledTimes(3)
  })

  it('nothing marked needs no second cycle', async () => {
    const e = engine(() => true)
    await cycleWithLauncherRepair(e, e.runCycle, FLAG, async () => 0)
    expect(e.runCycle).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(FLAG)).toBe('1')
  })

  it('a marking that fails leaves the flag unset, so the next successful cycle tries again', async () => {
    const e = engine(() => true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await cycleWithLauncherRepair(e, e.runCycle, FLAG, async () => { throw new Error('db closed') })
    expect(localStorage.getItem(FLAG)).toBeNull()
    const mark = vi.fn(async () => 1)
    await cycleWithLauncherRepair(e, e.runCycle, FLAG, mark)
    expect(mark).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(FLAG)).toBe('1')
    warn.mockRestore()
  })
})
