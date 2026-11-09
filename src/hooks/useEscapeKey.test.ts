import { describe, expect, it, vi } from 'vitest'
import { handleEscape } from './useEscapeKey'
import { pushDismiss } from '@/utils/dismissStack'

function press(key = 'Escape', target: unknown = { tagName: 'BODY' }) {
  return { key, target: target as EventTarget, defaultPrevented: false, preventDefault: vi.fn() }
}

describe('handleEscape', () => {
  it('closes the topmost surface and marks the press handled, leaving fullscreen alone', () => {
    const close = vi.fn()
    const unregister = pushDismiss(close)
    const exitFullscreen = vi.fn()
    const e = press()
    handleEscape(e, exitFullscreen)
    expect(close).toHaveBeenCalledOnce()
    expect(e.preventDefault).toHaveBeenCalledOnce()
    expect(exitFullscreen).not.toHaveBeenCalled()
    unregister()
  })

  it('leaves fullscreen on the desktop when nothing is open', () => {
    const exitFullscreen = vi.fn()
    handleEscape(press(), exitFullscreen)
    expect(exitFullscreen).toHaveBeenCalledOnce()
  })

  it('takes two presses with a modal open: the modal, then fullscreen', () => {
    const exitFullscreen = vi.fn()
    let open = true
    const unregister = pushDismiss(() => { open = false; unregister() })
    handleEscape(press(), exitFullscreen)
    expect(open).toBe(false)
    expect(exitFullscreen).not.toHaveBeenCalled()
    handleEscape(press(), exitFullscreen)
    expect(exitFullscreen).toHaveBeenCalledOnce()
  })

  it('never leaves fullscreen for Escape in a text field', () => {
    const exitFullscreen = vi.fn()
    for (const target of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
      handleEscape(press('Escape', target), exitFullscreen)
    }
    expect(exitFullscreen).not.toHaveBeenCalled()
  })

  it('leaves alone a press something else already handled, other keys, and the web and phones', () => {
    const exitFullscreen = vi.fn()
    handleEscape({ ...press(), defaultPrevented: true }, exitFullscreen)
    handleEscape(press('Enter'), exitFullscreen)
    expect(exitFullscreen).not.toHaveBeenCalled()
    expect(() => handleEscape(press())).not.toThrow()
  })
})
