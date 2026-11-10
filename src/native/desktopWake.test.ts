import { describe, expect, it, vi } from 'vitest'
import { installDesktopWake } from './desktopWake'

describe('the desktop wake signal', () => {
  it('replays visibilitychange for the hooks that kick on it, until removed', () => {
    let listener: ((why: unknown) => void) | null = null
    const off = vi.fn()
    const bridge = { shell: { onWake: (l: (why: unknown) => void) => { listener = l; return off } } } as never
    const doc = { dispatchEvent: vi.fn() }
    const stop = installDesktopWake(bridge, doc)
    listener!('resume')
    expect(doc.dispatchEvent).toHaveBeenCalledOnce()
    expect((doc.dispatchEvent.mock.calls[0][0] as Event).type).toBe('visibilitychange')
    stop()
    expect(off).toHaveBeenCalledOnce()
  })
})
