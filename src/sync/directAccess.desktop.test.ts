import { describe, expect, it, vi } from 'vitest'
import { createDirectAccessBridge, desktopDirectAccessPlugin, type DirectAccessBridge } from '@/native/directAccess'
import type { DesktopDirectAccess } from '@/native/desktop'
import { createDirectAccessTransport } from './directAccess'

function desktopFolder(): DesktopDirectAccess & { fire: () => void; listeners: Set<() => void> } {
  const listeners = new Set<() => void>()
  return {
    status: vi.fn(async () => ({ configured: true, name: 'Sync', path: '/Users/me/Sync', reachable: true })),
    pickFolder: vi.fn(async () => ({ cancelled: true as const })),
    disconnect: vi.fn(async () => {}),
    read: vi.fn(async () => ({ kind: 'text' as const, text: '{}' })),
    write: vi.fn(async () => ({ ok: true })),
    deleteFile: vi.fn(async () => ({ ok: true })),
    listFiles: vi.fn(async () => ({ names: ['glance-events.json'] })),
    readFile: vi.fn(async () => ({ kind: 'absent' as const })),
    writeFile: vi.fn(async () => ({ ok: true })),
    deleteFileAt: vi.fn(async () => ({ ok: true })),
    makeDir: vi.fn(async () => ({ ok: true })),
    onChanged: (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    listeners,
    fire: () => { for (const cb of listeners) cb() },
  }
}

describe('the desktop folder as the Direct Access plugin', () => {
  it('gives the Android bridge: a folder with files by path, and no iOS file slots', async () => {
    const folder = desktopFolder()
    const bridge = createDirectAccessBridge(desktopDirectAccessPlugin(folder), 'android')
    expect(bridge.paths).toBeDefined()
    expect(bridge.people).toBeUndefined()
    expect(await bridge.pick()).toBeNull() // cancelled
    expect(await bridge.paths!.list('GLANCE/events')).toEqual(['glance-events.json'])
    expect(await bridge.paths!.write('GLANCE/users/glance-users.json', '{}')).toBe(true)
    expect(folder.writeFile).toHaveBeenCalledWith({ rel: 'GLANCE/users/glance-users.json', text: '{}' })
    expect(await bridge.write('{"v":1}')).toBe(true)
    expect(folder.write).toHaveBeenCalledWith({ text: '{"v":1}' })
  })

  it('refuses the iOS-only file pickers', async () => {
    const plugin = desktopDirectAccessPlugin(desktopFolder())
    await expect(plugin.pickFile({ slot: 'people' })).rejects.toThrow('Not available on the desktop')
  })
})

describe('the folder watcher', () => {
  it('reaches the transport\'s change listeners, and is released with the last one', () => {
    const folder = desktopFolder()
    const bridge: DirectAccessBridge = {
      ...createDirectAccessBridge(desktopDirectAccessPlugin(folder), 'android'),
      onChanged: (cb) => folder.onChanged(cb),
    }
    const transport = createDirectAccessTransport({ bridge: () => bridge, storage: () => null })
    const a = vi.fn()
    const b = vi.fn()
    const offA = transport.onChanged(a)
    const offB = transport.onChanged(b)
    expect(folder.listeners.size).toBe(1)
    folder.fire()
    expect([a.mock.calls.length, b.mock.calls.length]).toEqual([1, 1])
    offA()
    offB()
    expect(folder.listeners.size).toBe(0)
  })
})
