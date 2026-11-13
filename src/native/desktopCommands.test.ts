import { afterEach, describe, expect, it, vi } from 'vitest'
import { commandAsWrite, commandVia, drainDesktopCommands } from './desktopCommands'
import { LG_LAUNCHER_ACTIONS } from '@/intents/launcherWrites'
import type { DesktopCommand } from './desktop'
import type { IntentContext } from '@/intents/handleIntent'

afterEach(() => { vi.unstubAllGlobals() })

const memStorage = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) } }
}

const cmd = (clientId: string, action = 'complete', payload: Record<string, unknown> = { chore_id: 'c1' }): DesktopCommand =>
  ({ clientId, action, payload, source: 'tray', at: '2026-11-10T12:00:00.000Z' })

function setup(queued: DesktopCommand[]) {
  vi.stubGlobal('localStorage', memStorage())
  vi.stubGlobal('window', { dispatchEvent: () => true })
  let pending = [...queued]
  const queue = {
    take: vi.fn(async () => [...pending]),
    ack: vi.fn(async (ids: string[]) => { pending = pending.filter((c) => !ids.includes(c.clientId)) }),
  }
  const logged: string[] = []
  const vias: string[] = []
  const ctxFor = (via: string): IntentContext => {
    vias.push(via)
    return {
      listChores: async () => [{ id: 1, sync_id: 'c1', name: 'Water plants' }] as never,
      logCompletion: async (id: number) => { logged.push(String(id)) },
    }
  }
  return { queue, ctxFor, logged, vias, pending: () => pending }
}

describe('the desktop command queue, page side', () => {
  it('maps the vocabulary onto the launcher writes', () => {
    expect(commandAsWrite(cmd('a'))).toEqual({ action: LG_LAUNCHER_ACTIONS.COMPLETE, payload: { chore_id: 'c1' }, clientId: 'a' })
    expect(commandAsWrite(cmd('b', 'log_interaction', {})).action).toBe(LG_LAUNCHER_ACTIONS.LOG_INTERACTION)
    expect(commandVia({ source: 'notification' })).toBe('a notification')
    expect(commandVia({ source: 'streamdeck' })).toBe('the Stream Deck')
  })

  it('applies a completion through the app handler, then acknowledges it', async () => {
    const s = setup([cmd('a')])
    const results = await drainDesktopCommands(s.queue, s.ctxFor)
    expect(results[0].result).toMatchObject({ success: true, chore_id: 'c1' })
    expect(s.logged).toEqual(['1'])
    expect(s.queue.ack).toHaveBeenCalledWith(['a'])
    expect(s.pending()).toEqual([])
    expect(s.vias).toEqual(['the tray'])
  })

  it('a replay after a crash before the acknowledgement is deduped by the ledger', async () => {
    const s = setup([cmd('a')])
    const ack = s.queue.ack
    s.queue.ack = vi.fn(async () => { throw new Error('crashed') })
    await drainDesktopCommands(s.queue, s.ctxFor).catch(() => {})
    s.queue.ack = ack
    const replay = await drainDesktopCommands(s.queue, s.ctxFor)
    expect(replay[0].result).toMatchObject({ success: true, deduped: true })
    expect(s.logged).toEqual(['1'])                         // logged once
    expect(s.pending()).toEqual([])
  })

  it('acknowledges a command it refuses, so it does not loop', async () => {
    const s = setup([cmd('x', 'complete', { chore_id: 'missing' })])
    const results = await drainDesktopCommands(s.queue, s.ctxFor)
    expect(results[0].result.success).toBe(false)
    expect(s.pending()).toEqual([])
  })

  it('an unreachable queue drains nothing', async () => {
    const results = await drainDesktopCommands({ take: async () => { throw new Error('gone') }, ack: async () => {} }, () => ({}))
    expect(results).toEqual([])
  })
})
