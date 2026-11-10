import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { menuLabels, syncDesktopMenuLabels } from './desktopMenu'
import { APPLICATION_MENU_LABEL_KEYS } from '../../electron/applicationMenu'

const en = JSON.parse(readFileSync(join(__dirname, '../../public/locales/en/translation.json'), 'utf-8'))

describe('desktop menu labels', () => {
  it('carry exactly the keys the main process accepts', () => {
    // electron/applicationMenu.ts rejects an incomplete set, and a key it does
    // not know is dropped; locales.test.ts holds every language to en's keys.
    expect(Object.keys(en.menu).sort()).toEqual([...APPLICATION_MENU_LABEL_KEYS].sort())
  })

  it('reads the current language’s menu block', () => {
    const t = vi.fn(() => ({ file: 'Datei', quit: 'Beenden' }))
    expect(menuLabels({ t } as never)).toEqual({ file: 'Datei', quit: 'Beenden' })
  })

  it('is null before the bundle has loaded (t returns the key)', () => {
    expect(menuLabels({ t: () => 'menu' } as never)).toBeNull()
    expect(menuLabels({ t: () => ({}) } as never)).toBeNull()
  })

  it('pushes on init and on every language change', () => {
    const handlers: Record<string, () => void> = {}
    let labels = { file: 'File' }
    const i18n = {
      t: () => labels,
      on: (event: string, fn: () => void) => { handlers[event] = fn },
      isInitialized: true,
    }
    const setMenuLabels = vi.fn()
    syncDesktopMenuLabels(i18n as never, { shell: { setMenuLabels, setTheme: vi.fn(), exitFullscreen: vi.fn(), log: vi.fn() } })
    expect(setMenuLabels).toHaveBeenLastCalledWith({ file: 'File' })
    labels = { file: 'Fichier' }
    handlers.languageChanged()
    expect(setMenuLabels).toHaveBeenLastCalledWith({ file: 'Fichier' })
  })
})
