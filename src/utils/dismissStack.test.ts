import { describe, it, expect, vi } from 'vitest'
import { pushDismiss, dismissTop } from './dismissStack'

describe('dismissStack', () => {
  it('reports when nothing is open, so Back can leave the app', () => {
    expect(dismissTop()).toBe(false)
  })

  it('dismisses only the most recently opened surface', () => {
    const settings = vi.fn()
    const sync = vi.fn()
    const offSettings = pushDismiss(settings)
    const offSync = pushDismiss(sync)

    expect(dismissTop()).toBe(true)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(settings).not.toHaveBeenCalled()

    offSync()
    expect(dismissTop()).toBe(true)
    expect(settings).toHaveBeenCalledTimes(1)

    offSettings()
    expect(dismissTop()).toBe(false)
  })

  it('unregisters the right entry when the same handler is pushed twice', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA1 = pushDismiss(a)
    const offB = pushDismiss(b)
    const offA2 = pushDismiss(a)

    offA2()
    dismissTop()
    expect(b).toHaveBeenCalledTimes(1)

    offB()
    offA1()
    expect(dismissTop()).toBe(false)
  })
})
