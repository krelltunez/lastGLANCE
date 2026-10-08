import { describe, expect, it } from 'vitest'
import en from '../../public/locales/en/translation.json'
import { ICON_GROUPS } from './registry'

// The picker renders each group's name from iconPicker.groups.<id>. A group
// added here without that key would show its raw key path; the locale parity
// test then carries the requirement into every other language.
describe('icon groups', () => {
  it('has an English name for every group id', () => {
    const names: Record<string, string> = en.iconPicker.groups
    const missing = ICON_GROUPS.map((g) => g.id).filter((id) => !names[id])
    expect(missing).toEqual([])
  })

  it('uses each id once', () => {
    const ids = ICON_GROUPS.map((g) => g.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
