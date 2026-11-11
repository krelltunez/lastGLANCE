import { describe, expect, it } from 'vitest'
import { keyName, recordShortcut, type KeyPress } from './shortcutRecorder'

const press = (code: string, mods: Partial<KeyPress> = {}, key = 'x'): KeyPress =>
  ({ key, code, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })

describe('recording a global shortcut', () => {
  it('names keys by their position, not the character Shift makes', () => {
    expect(keyName('KeyL')).toBe('L')
    expect(keyName('Digit1')).toBe('1')
    expect(keyName('Space')).toBe('Space')
    expect(keyName('ArrowUp')).toBe('Up')
    expect(keyName('F12')).toBe('F12')
    expect(keyName('IntlYen')).toBeNull()
  })

  it('records modifiers in a fixed order', () => {
    expect(recordShortcut(press('KeyL', { ctrlKey: true, shiftKey: true }), 'darwin')).toEqual({ kind: 'accelerator', accelerator: 'Ctrl+Shift+L' })
    expect(recordShortcut(press('Space', { metaKey: true, altKey: true }), 'darwin')).toEqual({ kind: 'accelerator', accelerator: 'Cmd+Alt+Space' })
    expect(recordShortcut(press('Digit1', { ctrlKey: true, shiftKey: true }, '!'), 'win32')).toEqual({ kind: 'accelerator', accelerator: 'Ctrl+Shift+1' })
  })

  it('calls the Windows and Linux logo key Super', () => {
    expect(recordShortcut(press('KeyL', { metaKey: true }), 'win32')).toEqual({ kind: 'accelerator', accelerator: 'Super+L' })
  })

  it('needs Ctrl, Alt or Cmd, so a shortcut cannot swallow typing; a function key may stand alone', () => {
    expect(recordShortcut(press('KeyL'), 'darwin')).toEqual({ kind: 'needs-modifier' })
    expect(recordShortcut(press('KeyL', { shiftKey: true }), 'darwin')).toEqual({ kind: 'needs-modifier' })
    expect(recordShortcut(press('F9'), 'darwin')).toEqual({ kind: 'accelerator', accelerator: 'F9' })
  })

  it('waits while only modifiers are held, and ignores keys it cannot name', () => {
    expect(recordShortcut(press('ShiftLeft', { shiftKey: true }, 'Shift'), 'darwin')).toEqual({ kind: 'ignore' })
    expect(recordShortcut(press('IntlYen', { ctrlKey: true }), 'darwin')).toEqual({ kind: 'ignore' })
  })
})
