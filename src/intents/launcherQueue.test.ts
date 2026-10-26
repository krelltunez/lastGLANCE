import { describe, expect, it, vi } from 'vitest'
import { drainLauncherQueue } from './launcherQueue'
import type { IntentContext } from './handleIntent'

// The launcher queue's drain (src/intents/launcherQueue.ts): writes before
// refreshes, each taken off the native queue only once its handler returns.

const L = 'com.lastglance.app.launcher.'

function ctxWith(events: string[]): IntentContext {
  const chores = [{ id: 1, sync_id: 'ch-1', name: 'Water', category_id: 1, target_cadence_days: null, elapsed_days: null }]
  return {
    listChores: async () => chores,
    logCompletion: async () => { events.push('logged') },
  } as unknown as IntentContext
}

describe('drainLauncherQueue', () => {
  // MUTATION: handle the entries in queue order and the write waits forever behind the refresh.
  it('handles writes before a refresh that never comes back, and acks each after its handler', async () => {
    const events: string[] = []
    const hooks = { runSyncCycle: () => new Promise<void>(() => {}), record: vi.fn() }
    void drainLauncherQueue({
      entries: [
        { action: `${L}REFRESH`, clientId: 'r1' },
        { action: `${L}COMPLETE`, clientId: 'w1', payload: { chore_id: 'ch-1' } },
      ],
      ctx: () => ctxWith(events),
      ack: (ids) => { events.push(`ack:${ids.join(',')}`) },
      hooks,
    })
    await vi.waitFor(() => expect(events).toContain('ack:w1'))
    expect(events).toEqual(['logged', 'ack:w1'])
  })

  it('a refused write is acked too (the launcher re-sends it); refreshes are skipped without hooks', async () => {
    const acked: string[] = []
    const results = await drainLauncherQueue({
      entries: [
        { action: `${L}COMPLETE`, clientId: 'w2', payload: { chore_id: 'nope' } },
        { action: `${L}REFRESH`, clientId: 'r2' },
      ],
      ctx: () => ctxWith([]),
      ack: (ids) => { acked.push(...ids) },
    })
    expect(results).toEqual([expect.objectContaining({ clientId: 'w2', result: expect.objectContaining({ success: false }) })])
    expect(acked).toEqual(['w2'])
  })

  it('stops between writes once cancelled, leaving the rest queued', async () => {
    const acked: string[] = []
    let cancelled = false
    await drainLauncherQueue({
      entries: [
        { action: `${L}COMPLETE`, clientId: 'w3', payload: { chore_id: 'ch-1' } },
        { action: `${L}COMPLETE`, clientId: 'w4', payload: { chore_id: 'ch-1' } },
      ],
      ctx: () => ctxWith([]),
      ack: (ids) => { acked.push(...ids); cancelled = true },
      cancelled: () => cancelled,
    })
    expect(acked).toEqual(['w3'])
  })
})
