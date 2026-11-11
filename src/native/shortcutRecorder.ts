// Recording a global shortcut from a key press (Settings, Desktop app): the
// page turns the press into an Electron accelerator ("Ctrl+Shift+L"), and main
// registers it (electron/main.ts, shell:set-shortcut). After dayGLANCE's
// makeHotkeyRecorder, with two changes: the key comes from `code`, so
// Shift+1 records "1" and not "!", and a shortcut must hold Ctrl, Alt or Cmd
// (Super off macOS), or a function key, so it cannot swallow ordinary typing.

export type KeyPress = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

export type Recorded =
  | { kind: 'accelerator'; accelerator: string }
  | { kind: 'needs-modifier' }
  | { kind: 'ignore' }

const NAMED: Record<string, string> = {
  Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\', Semicolon: ';',
  Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
}

/** The accelerator's key for a physical key, or null for one it cannot name. */
export function keyName(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code)
  if (m) return m[1]
  m = /^(?:Digit|Numpad)([0-9])$/.exec(code)
  if (m) return m[1]
  m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code)
  if (m) return `F${m[1]}`
  return NAMED[code] ?? null
}

export function recordShortcut(e: KeyPress, platform: string): Recorded {
  if (['Meta', 'Shift', 'Alt', 'Control', 'OS'].includes(e.key)) return { kind: 'ignore' }
  const key = keyName(e.code)
  if (!key) return { kind: 'ignore' }
  const mods: string[] = []
  if (e.metaKey) mods.push(platform === 'darwin' ? 'Cmd' : 'Super')
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  const functionKey = /^F\d+$/.test(key)
  if (mods.length === 0 && !functionKey) return { kind: 'needs-modifier' }
  if (e.shiftKey) mods.push('Shift')
  return { kind: 'accelerator', accelerator: [...mods, key].join('+') }
}
