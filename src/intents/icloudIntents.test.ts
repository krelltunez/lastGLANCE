import { describe, it, expect, vi } from 'vitest'

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web', isNativePlatform: () => false, isPluginAvailable: () => false },
  registerPlugin: () => ({}),
}))

import { buildEnvelope, filenameFor, ACTIONS, EVENTS, SOURCE_APPS, eventId, type Envelope } from '@glance-apps/intents'
import {
  createICloudDeliverer, pollICloudIntents, isICloudIntentsEnabled, setICloudIntentsEnabled, getICloudIntentsEnabledFlag,
  ICLOUD_EVENTS_PATH, ICLOUD_INTENTS_CURSOR_KEY,
} from './icloudIntents'
import type { ICloudBridge, ICloudContainer } from '@/native/icloud'
import type { DirectAccessRead } from '@/native/directAccess'
import type { OutboxIntent } from './outbox'

const memStorage = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, m }
}

/** dayGLANCE's iCloud container as the events folder sees it. */
function folder() {
  const files = new Map<string, string>()
  const downloading = new Set<string>()
  let available = true
  let dirMade = false
  const calls: { op: string; container?: ICloudContainer }[] = []
  const bridge: ICloudBridge = {
    available: async () => available,
    read: async (path, { container } = {}): Promise<DirectAccessRead> => {
      calls.push({ op: 'read', container })
      if (downloading.has(path)) return { kind: 'downloading' }
      return files.has(path) ? { kind: 'text', text: files.get(path)! } : { kind: 'absent' }
    },
    write: async (path, text, { container } = {}) => {
      calls.push({ op: 'write', container })
      if (!dirMade) return false
      files.set(path, text); return true
    },
    list: async (path, container) => {
      calls.push({ op: 'list', container })
      if (!available) return null
      return [...files.keys()].filter((p) => p.startsWith(path)).map((p) => p.slice(path.length))
    },
    remove: async (path) => files.delete(path),
    makeDir: async (_p, container) => { calls.push({ op: 'makeDir', container }); dirMade = true; return true },
    onChanged: () => () => {},
  }
  return { files, bridge, calls, downloading, setAvailable: (v: boolean) => { available = v }, mkdir: () => { dirMade = true } }
}

const intent = (title: string): OutboxIntent => {
  const at = new Date('2026-10-25T12:00:00.000Z')
  return { event_id: eventId(at), action: ACTIONS.CREATE, emitted_by: SOURCE_APPS.LASTGLANCE, emitted_at: at.toISOString(), payload: { title, due: '2026-10-25', all_day: true, source_app: SOURCE_APPS.LASTGLANCE } }
}

/** dayGLANCE telling lastGLANCE a task it sent was completed. */
const notifyFromDayglance = (at: string, entity: string): Envelope => buildEnvelope({
  action: ACTIONS.NOTIFY,
  payload: {
    event_id: '00000000-0000-4000-8000-000000000001', source_app: SOURCE_APPS.LASTGLANCE, source_entity_id: entity,
    event: EVENTS.COMPLETED, task_id: 't-' + entity, title: entity, timestamp: at, completed_at: at,
  },
  emittedBy: SOURCE_APPS.DAYGLANCE,
  emittedAt: new Date(at),
})

describe('the iCloud intents opt-in', () => {
  it('is off by default and needs the plugin too', () => {
    const storage = memStorage()
    expect(getICloudIntentsEnabledFlag(storage)).toBe(false)
    setICloudIntentsEnabled(true, storage)
    expect(getICloudIntentsEnabledFlag(storage)).toBe(true)
    expect(isICloudIntentsEnabled(() => null)).toBe(false)
    setICloudIntentsEnabled(false, storage)
    expect(storage.m.has('lg_icloud_intents_enabled')).toBe(false)
  })
})

describe('the iCloud deliverer', () => {
  it('writes a plaintext envelope into dayGLANCE\'s events folder, creating it on the first send', async () => {
    const f = folder()
    const deliver = createICloudDeliverer({ bridge: () => f.bridge, enabled: () => true })
    const i = intent('Call Sam')
    expect(await deliver(i)).toBe('delivered')
    const [path, text] = [...f.files.entries()][0]
    const envelope = JSON.parse(text)
    expect(path).toBe(ICLOUD_EVENTS_PATH + filenameFor(envelope))
    expect(path.startsWith('GLANCE/events/')).toBe(true)
    expect(envelope.encrypted).toBeUndefined()                 // never sealed on iCloud
    expect(envelope.event_id).toBe(i.event_id)                 // the outbox's id: re-delivery is idempotent
    expect(envelope.payload.title).toBe('Call Sam')
    expect(f.calls.filter((c) => c.op !== 'read').every((c) => c.container === 'dayglance')).toBe(true)
    expect(f.calls.map((c) => c.op)).toEqual(['write', 'makeDir', 'write'])
  })

  it('holds while off or while iCloud is away, and never gives up', async () => {
    const f = folder(); f.mkdir()
    let on = false
    const deliver = createICloudDeliverer({ bridge: () => f.bridge, enabled: () => on })
    expect(await deliver(intent('a'))).toBe('transient-fail')
    on = true
    f.setAvailable(false)
    expect(await deliver(intent('b'))).toBe('transient-fail')
    expect(await createICloudDeliverer({ bridge: () => null, enabled: () => true })(intent('c'))).toBe('transient-fail')
    expect(f.files.size).toBe(0)
  })
})

describe('the iCloud intents poll', () => {
  const put = (f: ReturnType<typeof folder>, e: Envelope | Record<string, unknown>, name?: string) => {
    f.files.set(ICLOUD_EVENTS_PATH + (name ?? filenameFor(e as Envelope)), JSON.stringify(e))
  }

  it('processes dayGLANCE\'s events in order from its container and moves the cursor', async () => {
    const f = folder()
    const storage = memStorage()
    const a = notifyFromDayglance('2026-10-25T10:00:00.000Z', 'chore-a')
    const b = notifyFromDayglance('2026-10-25T11:00:00.000Z', 'chore-b')
    put(f, b); put(f, a)
    const seen: string[] = []
    await pollICloudIntents({ bridge: () => f.bridge, storage, process: async (e) => { seen.push((e.payload as { source_entity_id: string }).source_entity_id) }, addActivityEntry: () => {} })
    expect(seen).toEqual(['chore-a', 'chore-b'])
    expect(storage.getItem(ICLOUD_INTENTS_CURSOR_KEY)).toBe('20261025T110000Z')
    expect(f.calls.every((c) => c.container === 'dayglance')).toBe(true)
  })

  it('a file still downloading stops the pass with the cursor in place, and is read on the next poll', async () => {
    const f = folder()
    const storage = memStorage()
    const a = notifyFromDayglance('2026-10-25T10:00:00.000Z', 'chore-a')
    const b = notifyFromDayglance('2026-10-25T11:00:00.000Z', 'chore-b')
    put(f, a); put(f, b)
    f.downloading.add(ICLOUD_EVENTS_PATH + filenameFor(a))
    const seen: string[] = []
    const process = async (e: Envelope) => { seen.push((e.payload as { source_entity_id: string }).source_entity_id) }
    await pollICloudIntents({ bridge: () => f.bridge, storage, process, addActivityEntry: () => {} })
    expect(seen).toEqual([])
    expect(storage.getItem(ICLOUD_INTENTS_CURSOR_KEY)).toBeNull()
    f.downloading.clear()
    await pollICloudIntents({ bridge: () => f.bridge, storage, process, addActivityEntry: () => {} })
    expect(seen).toEqual(['chore-a', 'chore-b'])
  })

  it('skips an encrypted envelope as a misconfigured sender, and malformed files, without stalling', async () => {
    const f = folder()
    const storage = memStorage()
    const ok = notifyFromDayglance('2026-10-25T11:00:00.000Z', 'chore-b')
    put(f, { encrypted: true, v: 1 }, '20261025T090000Z-aaaaaa.json')
    f.files.set(ICLOUD_EVENTS_PATH + '20261025T093000Z-bbbbbb.json', 'not json')
    put(f, ok)
    const warnings: string[] = []
    const seen: string[] = []
    await pollICloudIntents({
      bridge: () => f.bridge, storage,
      process: async (e) => { seen.push((e.payload as { source_entity_id: string }).source_entity_id) },
      addActivityEntry: (e) => { warnings.push(e.type) },
    })
    expect(warnings).toContain('warning')
    expect(seen).toEqual(['chore-b'])
  })

  it('does nothing while iCloud is away', async () => {
    const f = folder()
    put(f, notifyFromDayglance('2026-10-25T10:00:00.000Z', 'chore-a'))
    f.setAvailable(false)
    const process = vi.fn(async () => {})
    await pollICloudIntents({ bridge: () => f.bridge, storage: memStorage(), process, addActivityEntry: () => {} })
    expect(process).not.toHaveBeenCalled()
  })
})
